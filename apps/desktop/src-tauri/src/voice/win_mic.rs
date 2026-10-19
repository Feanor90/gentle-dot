//! Windows local capture: shared/event-driven WASAPI. COM never leaves the capture thread.
//! A bounded delivery thread keeps Sink callbacks (including reentrant teardown) off that
//! thread. Close joins native capture first; a callback can then close its own delivery loop.

use super::win_audio::Format;
use super::{audio::Resampler, Authorization, Microphone, Sink, Stream, VoiceError};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use windows::core::HRESULT;
use windows::Win32::Foundation::{E_ACCESSDENIED, ERROR_NOT_FOUND, HANDLE, WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, WaitForSingleObject};

const MICROPHONE_PRIVACY: &str = "Microphone access is off for Gentle Dot. Turn on Microphone access and Let desktop apps access your microphone in Windows Settings → Privacy & security → Microphone.";

fn api_error(code: HRESULT) -> VoiceError {
    match code {
        E_ACCESSDENIED => VoiceError::Failed(MICROPHONE_PRIVACY.into()),
        code if code == HRESULT::from_win32(ERROR_NOT_FOUND.0) => VoiceError::NoMicrophone,
        AUDCLNT_E_DEVICE_INVALIDATED | AUDCLNT_E_SERVICE_NOT_RUNNING | AUDCLNT_E_RESOURCES_INVALIDATED => VoiceError::Interrupted,
        _ => VoiceError::Failed(format!("The microphone could not record: {code}")),
    }
}

fn native<T>(result: windows::core::Result<T>) -> Result<T, VoiceError> {
    result.map_err(|error| api_error(error.code()))
}

fn capture_event(result: WAIT_EVENT) -> Result<bool, VoiceError> {
    match result {
        WAIT_OBJECT_0 => Ok(false),
        value if value.0 == WAIT_OBJECT_0.0 + 1 => Ok(true),
        WAIT_TIMEOUT => Err(VoiceError::Failed("The microphone stopped delivering audio.".into())),
        _ => Err(VoiceError::Interrupted),
    }
}

/// Only WASAPI owns this pointer; it is valid until release, or may be NULL for silence.
/// Keep the release call outside decoding's Result path so rejected packets are returned too.
unsafe fn read_packet(
    format: &Format,
    data: *const u8,
    frames: u32,
    silent: bool,
    release: impl FnOnce() -> Result<(), VoiceError>,
) -> Result<Vec<f32>, VoiceError> {
    let decoded = (|| {
        let bytes = if silent { None } else {
            let size = (frames as usize).checked_mul(format.align).ok_or(VoiceError::Interrupted)?;
            if data.is_null() || size > isize::MAX as usize { return Err(VoiceError::Interrupted); }
            // Caller guarantees the acquired WASAPI buffer spans frames * block alignment.
            Some(unsafe { std::slice::from_raw_parts(data, size) })
        };
        format.decode(bytes, frames as usize)
    })();
    let released = release();
    let mono = decoded?;
    released?;
    Ok(mono)
}

struct Event(OwnedHandle);
impl Event {
    fn new(manual: bool) -> Result<Self, VoiceError> {
        let handle = native(unsafe { CreateEventW(None, manual, false, None) })?;
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }
    fn handle(&self) -> HANDLE { HANDLE(self.0.as_raw_handle()) }
    fn signal(&self) { let _ = unsafe { SetEvent(self.handle()) }; }
    fn is_set(&self) -> Result<bool, VoiceError> {
        match unsafe { WaitForSingleObject(self.handle(), 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(VoiceError::Interrupted),
        }
    }
}

pub struct WinMicrophone;
impl Microphone for WinMicrophone {
    // WASAPI has no desktop permission-prompt API. These mean "try open", not privacy proof.
    fn authorization(&self) -> Authorization { Authorization::Authorized }
    fn request_authorization(&self) -> Authorization { Authorization::Authorized }
    fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
        open_capture(sink, Wasapi::open)
    }
}

/// Private device seam: tests substitute packets/events, never the real default endpoint.
trait Capture {
    fn next(&mut self, stop: &Event) -> Result<Option<Vec<f32>>, VoiceError>;
}

struct CaptureStream {
    stop: Arc<Event>,
    closed: Arc<AtomicBool>,
    capture: Option<JoinHandle<()>>,
    delivery: Option<JoinHandle<()>>,
}

impl Stream for CaptureStream {
    fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        self.stop.signal();
        if let Some(worker) = self.capture.take() { let _ = worker.join(); }
        if let Some(delivery) = self.delivery.take() {
            // Sink::failed and user event callbacks may synchronously discard this stream.
            // Native resources have already been joined/released; this loop exits on return.
            if delivery.thread().id() != thread::current().id() { let _ = delivery.join(); }
        }
    }
}
impl Drop for CaptureStream {
    fn drop(&mut self) { self.close(); }
}

fn open_capture<C: Capture + 'static>(sink: Sink, create: impl FnOnce() -> Result<C, VoiceError> + Send + 'static) -> Result<Box<dyn Stream>, VoiceError> {
    let stop = Arc::new(Event::new(true)?);
    let closed = Arc::new(AtomicBool::new(false));
    let (ready, started) = mpsc::sync_channel(1);
    let (audio, incoming) = mpsc::sync_channel(8);
    let failure = Arc::new(Mutex::new(None));
    let (stopping, failed) = (stop.clone(), failure.clone());
    let capture = thread::Builder::new().name("voice-wasapi".into()).spawn(move || {
        let result = (|| {
            let mut device = match create() {
                Ok(device) => device,
                Err(error) => { let _ = ready.send(Err(error)); return Ok(()); }
            };
            if ready.send(Ok(())).is_err() { return Ok(()); }
            while !stopping.is_set()? {
                let Some(samples) = device.next(&stopping)? else { break };
                if stopping.is_set()? { break; }
                // Never block native shutdown behind a callback that is itself closing us.
                if !samples.is_empty() && audio.try_send(samples).is_err() { return Err(VoiceError::Interrupted); }
            }
            Ok(())
        })(); // device/COM released BEFORE delivery can report an interruption.
        *failed.lock().unwrap_or_else(|p| p.into_inner()) = result.err();
        drop(audio);
    }).map_err(|error| VoiceError::Failed(format!("The microphone could not start: {error}")))?;
    match started.recv() {
        Ok(Ok(())) => {},
        result => {
            stop.signal();
            let _ = capture.join();
            return Err(match result {
                Ok(Err(error)) => error,
                _ => VoiceError::Interrupted,
            });
        }
    }
    let delivering = closed.clone();
    let delivery = match thread::Builder::new().name("voice-audio".into()).spawn(move || {
        while let Ok(samples) = incoming.recv() {
            if delivering.load(Ordering::SeqCst) { return; }
            sink.audio(&samples);
        }
        if !delivering.load(Ordering::SeqCst) {
            let error = failure.lock().unwrap_or_else(|p| p.into_inner()).take();
            if let Some(error) = error { sink.failed(&error.to_string()); }
        }
    }) {
        Ok(delivery) => delivery,
        Err(error) => {
            stop.signal();
            let _ = capture.join();
            return Err(VoiceError::Failed(format!("The microphone could not start: {error}")));
        }
    };
    Ok(Box::new(CaptureStream { stop, closed, capture: Some(capture), delivery: Some(delivery) }))
}

struct Com;
impl Drop for Com {
    fn drop(&mut self) { unsafe { CoUninitialize() }; }
}
struct Mix(*mut WAVEFORMATEX);
impl Drop for Mix {
    fn drop(&mut self) { unsafe { CoTaskMemFree(Some(self.0.cast())) }; }
}
struct Wasapi {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: Event,
    format: Format,
    resampler: Resampler,
    // Fields drop in declaration order: every COM interface must go before this guard.
    _com: Com,
}
impl Wasapi {
    fn open() -> Result<Self, VoiceError> {
        unsafe {
            native(CoInitializeEx(None, COINIT_MULTITHREADED).ok())?;
            let com = Com;
            let enumerator: IMMDeviceEnumerator = native(CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL))?;
            let device = native(enumerator.GetDefaultAudioEndpoint(eCapture, eConsole))?;
            let client: IAudioClient = native(device.Activate(CLSCTX_ALL, None))?;
            let mix = Mix(native(client.GetMixFormat())?);
            if mix.0.is_null() { return Err(VoiceError::Failed("The microphone returned no audio format.".into())); }
            // GetMixFormat owns an allocation of WAVEFORMATEX plus cbSize extension bytes.
            let size = 18 + usize::from(std::ptr::read_unaligned(mix.0).cbSize);
            let format = Format::parse(std::slice::from_raw_parts(mix.0.cast(), size))?;
            let event = Event::new(false)?;
            native(client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, 0, mix.0, None))?;
            native(client.SetEventHandle(event.handle()))?;
            let capture = native(client.GetService())?;
            native(client.Start())?;
            let resampler = Resampler::new(f64::from(format.rate));
            Ok(Self { client, capture, event, format, resampler, _com: com })
        }
    }
}
impl Capture for Wasapi {
    fn next(&mut self, stop: &Event) -> Result<Option<Vec<f32>>, VoiceError> {
        unsafe {
            loop {
                if stop.is_set()? { return Ok(None); }
                if native(self.capture.GetNextPacketSize())? != 0 {
                    let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0, 0);
                    native(self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None))?;
                    let mono = read_packet(&self.format, data, frames,
                        flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0,
                        || native(self.capture.ReleaseBuffer(frames)))?;
                    return Ok(Some(self.resampler.process(&mono)));
                }
                // Stop is index zero, so it wins when both events are signaled.
                if !capture_event(WaitForMultipleObjects(&[stop.handle(), self.event.handle()], false, 2_000))? {
                    return Ok(None);
                }
            }
        }
    }
}
impl Drop for Wasapi {
    fn drop(&mut self) { let _ = unsafe { self.client.Stop() }; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::{FakeClock, FakeRecognizer, Recorder};
    use crate::voice::{Voice, VoiceEvent};
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    use std::time::{Duration, Instant};

    struct FakeCapture {
        input: mpsc::Receiver<Result<Vec<f32>, VoiceError>>,
        released: Arc<AtomicUsize>,
    }

    impl Capture for FakeCapture {
        fn next(&mut self, stop: &Event) -> Result<Option<Vec<f32>>, VoiceError> {
            loop {
                if stop.is_set()? { return Ok(None); }
                match self.input.recv_timeout(Duration::from_millis(5)) {
                    Ok(result) => return result.map(Some),
                    Err(mpsc::RecvTimeoutError::Timeout) => {},
                    Err(_) => return Err(VoiceError::Interrupted),
                }
            }
        }
    }

    impl Drop for FakeCapture {
        fn drop(&mut self) { self.released.fetch_add(1, Ordering::SeqCst); }
    }

    struct TestMic(Mutex<Option<Result<FakeCapture, VoiceError>>>);
    impl Microphone for TestMic {
        fn authorization(&self) -> Authorization { WinMicrophone.authorization() }
        fn request_authorization(&self) -> Authorization { WinMicrophone.request_authorization() }
        fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
            let result = self.0.lock().unwrap().take().unwrap();
            open_capture(sink, move || result)
        }
    }

    fn rig(result: Result<FakeCapture, VoiceError>) -> (Arc<Voice>, Arc<FakeRecognizer>, Recorder) {
        let recognizer = Arc::new(FakeRecognizer::granted());
        *recognizer.final_text.lock().unwrap() = Some("done".into());
        let voice = Arc::new(Voice::new(Arc::new(TestMic(Mutex::new(Some(result)))), recognizer.clone(), Arc::new(FakeClock(AtomicU64::new(0)))));
        (voice, recognizer, Recorder::default())
    }

    fn device() -> (FakeCapture, mpsc::Sender<Result<Vec<f32>, VoiceError>>, Arc<AtomicUsize>) {
        let (tx, input) = mpsc::channel();
        let released = Arc::new(AtomicUsize::new(0));
        (FakeCapture { input, released: released.clone() }, tx, released)
    }

    fn until(mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !done() {
            assert!(Instant::now() < deadline, "capture must not deadlock");
            std::thread::yield_now();
        }
    }

    #[test]
    fn startup_errors_are_synchronous_and_cancel_the_recognizer() {
        for error in [VoiceError::NoMicrophone, api_error(E_ACCESSDENIED), VoiceError::Interrupted] {
            let (voice, recognizer, events) = rig(Err(error.clone()));
            assert!(voice.status().available, "status cannot establish Windows privacy authorization");
            assert_eq!(voice.start(None, events.events()), Err(error));
            assert_eq!(recognizer.log.lock().unwrap().cancelled, 1);
            assert_eq!(voice.cancel(), Ok(()));
            assert!(events.seen().is_empty());
        }
        assert_eq!(api_error(E_ACCESSDENIED).to_string(), MICROPHONE_PRIVACY);
        assert_eq!(api_error(AUDCLNT_E_DEVICE_INVALIDATED), VoiceError::Interrupted);
        assert_eq!(api_error(HRESULT::from_win32(ERROR_NOT_FOUND.0)), VoiceError::NoMicrophone);
    }

    #[test]
    fn every_acquired_packet_is_released_even_when_silent_or_invalid() {
        let mut wave = vec![0u8; 18];
        wave[0..2].copy_from_slice(&3u16.to_le_bytes());
        wave[2..4].copy_from_slice(&1u16.to_le_bytes());
        wave[4..8].copy_from_slice(&16_000u32.to_le_bytes());
        wave[8..12].copy_from_slice(&64_000u32.to_le_bytes());
        wave[12..14].copy_from_slice(&4u16.to_le_bytes());
        wave[14..16].copy_from_slice(&32u16.to_le_bytes());
        let format = Format::parse(&wave).unwrap();
        let (valid, invalid) = (0.5f32.to_le_bytes(), f32::NAN.to_le_bytes());
        for (data, silent, expected) in [
            (valid.as_ptr(), false, Some(vec![0.5])),
            (std::ptr::null(), true, Some(vec![0.0])),
            (std::ptr::null(), false, None),
            (invalid.as_ptr(), false, None),
        ] {
            let mut releases = 0;
            let result = unsafe { read_packet(&format, data, 1, silent, || { releases += 1; Ok(()) }) };
            assert_eq!(result.ok(), expected);
            assert_eq!(releases, 1);
        }
        assert_eq!(unsafe { read_packet(&format, valid.as_ptr(), 1, false, || Err(VoiceError::Interrupted)) }, Err(VoiceError::Interrupted));
    }

    #[test]
    fn stop_has_priority_and_wait_failures_interrupt() {
        let stop = Event::new(true).unwrap();
        let audio = Event::new(false).unwrap();
        audio.signal();
        stop.signal();
        let result = unsafe { WaitForMultipleObjects(&[stop.handle(), audio.handle()], false, 0) };
        assert_eq!(capture_event(result), Ok(false));
        assert_eq!(capture_event(WAIT_EVENT(1)), Ok(true));
        for event in [WAIT_EVENT(u32::MAX), WAIT_EVENT(128)] {
            assert_eq!(capture_event(event), Err(VoiceError::Interrupted));
        }
    }

    #[test]
    fn cancel_during_startup_preserves_the_synchronous_device_error() {
        struct StartingMic(Arc<crate::voice::fake::Gate>, mpsc::Sender<()>);
        impl Microphone for StartingMic {
            fn authorization(&self) -> Authorization { Authorization::Authorized }
            fn request_authorization(&self) -> Authorization { self.authorization() }
            fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
                let (gate, entered) = (self.0.clone(), self.1.clone());
                open_capture::<FakeCapture>(sink, move || {
                    entered.send(()).unwrap();
                    gate.wait();
                    Err(VoiceError::NoMicrophone)
                })
            }
        }
        let gate = Arc::new(crate::voice::fake::Gate::default());
        let (entered, waiting) = mpsc::channel();
        let recognizer = Arc::new(FakeRecognizer::granted());
        let voice = Arc::new(Voice::new(Arc::new(StartingMic(gate.clone(), entered)), recognizer.clone(), Arc::new(FakeClock(AtomicU64::new(0)))));
        let starting = voice.clone();
        let worker = thread::spawn(move || starting.start(None, Recorder::default().events()));
        waiting.recv_timeout(Duration::from_secs(3)).unwrap();
        voice.cancel().unwrap();
        gate.release();
        assert_eq!(worker.join().unwrap(), Err(VoiceError::NoMicrophone));
        assert_eq!(recognizer.log.lock().unwrap().cancelled, 1);
        assert_eq!(voice.stop(), Err(VoiceError::NotRecording));
    }

    #[test]
    fn stop_and_cancel_join_release_and_discard_late_audio() {
        for cancel in [false, true] {
            let (device, tx, released) = device();
            let (voice, recognizer, events) = rig(Ok(device));
            voice.start(None, events.events()).unwrap();
            tx.send(Ok(vec![0.25; 160])).unwrap();
            until(|| recognizer.log.lock().unwrap().fed.len() == 160);
            if cancel { voice.cancel().unwrap(); } else { assert_eq!(voice.stop().unwrap().text, "done"); }
            assert_eq!(released.load(Ordering::SeqCst), 1);
            let before = events.seen();
            assert!(tx.send(Ok(vec![1.0; 160])).is_err());
            voice.cancel().unwrap();
            assert_eq!(events.seen(), before);
            assert_eq!(recognizer.log.lock().unwrap().fed, vec![0.25; 160]);
        }
    }

    #[test]
    fn stalled_delivery_fills_queue_and_interrupts_without_blocking_capture_release() {
        let (device, tx, released) = device();
        let (voice, recognizer, events) = rig(Ok(device));
        voice.start(None, events.events()).unwrap();
        // Deliberately pin honest failure under backpressure: never block capture or
        // silently drop transcript audio. One packet can be in delivery, eight queued.
        let stalled = recognizer.log.lock().unwrap();
        // Capture may exit on packet nine before delivery receives its first packet.
        let sent = (0..10).filter(|_| tx.send(Ok(vec![0.25; 160])).is_ok()).count();
        until(|| released.load(Ordering::SeqCst) == 1);
        drop(stalled);
        assert!(sent > 8);
        until(|| events.seen().iter().any(|event| matches!(event, VoiceEvent::Error(_))));
        until(|| recognizer.log.lock().unwrap().cancelled == 1);
        assert_eq!(voice.stop(), Err(VoiceError::NotRecording));
        voice.cancel().unwrap();
        assert_eq!(events.seen().into_iter().filter(|event| matches!(event, VoiceEvent::Error(_))).collect::<Vec<_>>(),
            vec![VoiceEvent::Error(VoiceError::Interrupted.to_string())]);
        assert_eq!(recognizer.log.lock().unwrap().cancelled, 1);
        assert_eq!(released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn watchdog_timeout_reports_audio_stall_through_the_failure_path() {
        let expected = VoiceError::Failed("The microphone stopped delivering audio.".into());
        assert_eq!(capture_event(WAIT_TIMEOUT), Err(expected.clone()));
        let (device, tx, released) = device();
        let (voice, recognizer, events) = rig(Ok(device));
        voice.start(None, events.events()).unwrap();
        tx.send(capture_event(WAIT_TIMEOUT).map(|_| vec![])).unwrap();
        until(|| events.seen().iter().any(|event| matches!(event, VoiceEvent::Error(_))));
        until(|| recognizer.log.lock().unwrap().cancelled == 1);
        assert_eq!(events.seen(), vec![VoiceEvent::Error(expected.to_string())]);
        assert_eq!(released.load(Ordering::SeqCst), 1);
        assert_eq!(recognizer.log.lock().unwrap().cancelled, 1);
        assert_eq!(voice.stop(), Err(VoiceError::NotRecording));
        voice.cancel().unwrap();
        assert_eq!(events.seen(), vec![VoiceEvent::Error(expected.to_string())]);
    }

    #[test]
    fn interruption_releases_device_before_error_callback_teardown() {
        let (device, tx, released) = device();
        let (voice, recognizer, events) = rig(Ok(device));
        voice.start(None, events.events()).unwrap();
        tx.send(Err(VoiceError::Interrupted)).unwrap();
        until(|| recognizer.log.lock().unwrap().cancelled == 1);
        assert_eq!(released.load(Ordering::SeqCst), 1);
        assert_eq!(events.seen(), vec![VoiceEvent::Error(VoiceError::Interrupted.to_string())]);
        assert_eq!(voice.stop(), Err(VoiceError::NotRecording));
    }

    #[test]
    fn reentrant_cancel_from_a_level_callback_does_not_join_itself() {
        let (device, tx, released) = device();
        let (voice, recognizer, _) = rig(Ok(device));
        let weak = Arc::downgrade(&voice);
        let (done, finished) = mpsc::channel();
        voice.start(None, Arc::new(move |_| {
            weak.upgrade().unwrap().cancel().unwrap();
            done.send(()).unwrap();
        })).unwrap();
        tx.send(Ok(vec![0.5; 160])).unwrap();
        finished.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(released.load(Ordering::SeqCst), 1);
        assert!(recognizer.log.lock().unwrap().fed.is_empty());
    }

    #[test]
    fn stream_drop_and_repeated_close_release_once() {
        let (device, _tx, released) = device();
        let fake = crate::voice::fake::FakeMicrophone::granted();
        let events = Recorder::default();
        // Obtain a real public Sink without opening a native endpoint.
        let recognizer = Arc::new(FakeRecognizer::granted());
        let v = Voice::new(Arc::new(fake), recognizer.clone(), Arc::new(FakeClock(AtomicU64::new(0))));
        v.start(None, events.events()).unwrap();
        let mut stream = open_capture(recognizer.sink(), move || Ok(device)).unwrap();
        stream.close();
        stream.close();
        drop(stream);
        assert_eq!(released.load(Ordering::SeqCst), 1);
        let (another, _tx, dropped) = self::device();
        let stream = open_capture(recognizer.sink(), move || Ok(another)).unwrap();
        drop(stream);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        v.cancel().unwrap();
    }
}
