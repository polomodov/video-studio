// Canvas keeps decoded frames in the page instead of relying on the embedded
// browser's native video compositing layer, which can disappear on hide/seek.
export function mirrorFrames(video, canvas, { raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame, onFrame } = {}) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  let pending = null, disposed = false;
  const nativeFrames = typeof video.requestVideoFrameCallback === 'function';
  function draw() {
    if (disposed || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, 1280 / video.videoWidth, 1920 / video.videoHeight);
    const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    onFrame?.();
  }
  function stop() {
    if (pending === null) return;
    if (nativeFrames) video.cancelVideoFrameCallback(pending);
    else caf(pending);
    pending = null;
  }
  function schedule() {
    if (disposed || video.paused || video.ended || pending !== null) return;
    pending = nativeFrames ? video.requestVideoFrameCallback(tick) : raf(tick);
  }
  function tick() { pending = null; draw(); schedule(); }
  function play() { draw(); schedule(); }
  function pause() { stop(); draw(); }
  function empty() { stop(); context.clearRect(0, 0, canvas.width, canvas.height); }
  const events = { loadeddata: draw, seeked: draw, resize: draw, play, playing: play, pause, ended: pause, emptied: empty };
  for (const [event, listener] of Object.entries(events)) video.addEventListener(event, listener);
  play();
  return () => {
    disposed = true; stop();
    for (const [event, listener] of Object.entries(events)) video.removeEventListener(event, listener);
  };
}

export function mountCanvasPlayer(video, { label, onError } = {}) {
  const frame = video.parentElement;
  const canvas = document.createElement('canvas');
  canvas.className = 'video-surface';
  canvas.setAttribute('aria-hidden', 'true');
  const dispose = mirrorFrames(video, canvas, { onFrame: () => video.dispatchEvent(new Event('studioframe')) });
  if (!dispose) return; // Native controls remain available without Canvas 2D.
  frame.classList.add('frame-player');
  video.classList.add('canvas-decoder');
  video.controls = false;
  frame.append(canvas);
  const controls = document.createElement('div');
  controls.className = 'video-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', label);
  function button(text, action) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = text;
    node.addEventListener('click', action); controls.append(node);
    return node;
  }
  const play = button('▶', async () => {
    if (!video.paused) return video.pause();
    try { await video.play(); } catch { onError?.('Не удалось запустить видео. Попробуйте ещё раз.', true); }
  });
  const clock = document.createElement('span'); clock.className = 'video-clock'; controls.append(clock);
  const mute = button('Звук', () => { video.muted = !video.muted; });
  if (frame.requestFullscreen) button('⛶', () => {
    const operation = document.fullscreenElement === frame ? document.exitFullscreen() : frame.requestFullscreen();
    operation.catch(() => onError?.('Полноэкранный просмотр недоступен в этом браузере.', true));
  }).setAttribute('aria-label', `${label}: на весь экран`);
  const seek = document.createElement('input');
  seek.type = 'range'; seek.min = '0'; seek.max = '1'; seek.step = '0.01'; seek.value = '0';
  seek.setAttribute('aria-label', `${label}: позиция воспроизведения`);
  seek.addEventListener('input', () => {
    if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, Number(seek.value));
  });
  controls.append(seek); frame.append(controls);
  const format = (value) => {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  function sync() {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    play.textContent = video.paused ? '▶' : 'Ⅱ';
    play.setAttribute('aria-label', `${label}: ${video.paused ? 'воспроизвести' : 'пауза'}`);
    play.disabled = !video.getAttribute('src');
    clock.textContent = `${format(video.currentTime)} / ${format(duration)}`;
    seek.disabled = !duration; seek.max = String(duration || 1);
    if (document.activeElement !== seek) seek.value = String(video.currentTime || 0);
    mute.textContent = video.muted ? 'Без звука' : 'Звук';
    mute.setAttribute('aria-label', `${label}: ${video.muted ? 'включить' : 'выключить'} звук`);
  }
  for (const event of ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended', 'volumechange', 'emptied']) video.addEventListener(event, sync);
  sync();
}

// Apply the current draft's interval to every playback entry point, including
// native/custom controls. Keep the limit after stopping so replay cannot escape it.
export function limitPlayback(video, getRange, { raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame } = {}) {
  let pending = null, disposed = false;
  const valid = (range) => range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start;
  function cancel() {
    if (pending !== null) caf(pending);
    pending = null;
  }
  function check() {
    if (disposed || video.paused || video.seeking) return;
    const range = getRange();
    if (!range) return;
    if (!valid(range)) { video.pause(); return; }
    if (video.currentTime >= range.end) {
      video.pause();
      video.currentTime = range.end;
    } else if (video.currentTime < range.start) video.currentTime = range.start;
  }
  function schedule() {
    if (!disposed && !video.paused && !video.ended && pending === null) pending = raf(tick);
  }
  function tick() { pending = null; check(); schedule(); }
  function play() {
    const range = getRange();
    if (valid(range) && (video.currentTime < range.start || video.currentTime >= range.end)) video.currentTime = range.start;
    check(); schedule();
  }
  function update() { check(); schedule(); }
  const listeners = { play, playing: update, timeupdate: check, seeked: update, pause: cancel, ended: cancel, emptied: cancel };
  for (const [event, listener] of Object.entries(listeners)) video.addEventListener(event, listener);
  if (!video.paused) play();
  return { update, dispose() {
    disposed = true; cancel();
    for (const [event, listener] of Object.entries(listeners)) video.removeEventListener(event, listener);
  } };
}
