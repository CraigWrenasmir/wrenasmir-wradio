const audio = document.getElementById("audio");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const trackTitle = document.getElementById("trackTitle");
const trackMeta = document.getElementById("trackMeta");
const helperText = document.getElementById("helperText");
const powerBtn = document.getElementById("powerBtn");
const nextBtn = document.getElementById("nextBtn");
const shuffleBtn = document.getElementById("shuffleBtn");
const stationDial = document.getElementById("stationDial");
const stationLabels = document.getElementById("stationLabels");
const volumeDial = document.getElementById("volumeDial");
const toneDial = document.getElementById("toneDial");
const scopeCanvas = document.getElementById("scopeCanvas");
const eqBarsRoot = document.getElementById("eqBars");
const scopeCtx = scopeCanvas.getContext("2d");

const state = {
  stations: [],
  stationIndex: 0,
  currentTrack: null,
  isShuffle: true,
  isPoweredOn: false,
  lastTrackByStation: {},
  audioCtx: null,
  analyser: null,
  sourceNode: null,
  toneFilter: null,
  gainNode: null,
  frequencyData: null,
  waveformData: null,
  eqBars: [],
  animationFrameId: null,
  visualSeed: 0,
  consecutiveTrackErrors: 0,
  useAudioGraph: false,
  stationSnapAnimating: false
};

function setStatus(text, mode = "idle") {
  statusText.textContent = text;
  statusDot.classList.remove("live", "warn");
  if (mode === "live") statusDot.classList.add("live");
  if (mode === "warn") statusDot.classList.add("warn");
}

function sanitizeTrack(track) {
  return track && typeof track.url === "string" && track.url.startsWith("http");
}

function getCurrentStation() {
  return state.stations[state.stationIndex];
}

function buildEqBars(count = 20) {
  eqBarsRoot.innerHTML = "";
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const bar = document.createElement("span");
    bar.className = "eq-bar";
    eqBarsRoot.appendChild(bar);
    bars.push(bar);
  }
  state.eqBars = bars;
}

function renderStationLabels() {
  stationLabels.innerHTML = "";
  state.stations.forEach((station, index) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `station-label${index === state.stationIndex ? " active" : ""}`;
    el.textContent = station.name;
    el.dataset.stationIndex = String(index);
    el.setAttribute("aria-label", `Tune to ${station.name}`);
    stationLabels.appendChild(el);
  });
}

function updateNowPlaying(track, station) {
  trackTitle.textContent = track.title || "Untitled Track";
  trackMeta.textContent = `${station.name} Station`;
}

async function initAudioGraph() {
  if (!state.useAudioGraph) {
    return;
  }

  if (state.audioCtx) {
    if (state.audioCtx.state === "suspended") {
      await state.audioCtx.resume();
    }
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return;
  }

  state.audioCtx = new AudioContextClass();
  try {
    state.sourceNode = state.audioCtx.createMediaElementSource(audio);
  } catch (_) {
    // Some hosts do not expose CORS headers; playback should still work without reactive analysis.
    state.audioCtx = null;
    state.sourceNode = null;
    state.toneFilter = null;
    state.analyser = null;
    state.frequencyData = null;
    state.waveformData = null;
    return;
  }
  state.toneFilter = state.audioCtx.createBiquadFilter();
  state.toneFilter.type = "lowpass";
  state.toneFilter.Q.value = 0.7;
  state.gainNode = state.audioCtx.createGain();

  state.analyser = state.audioCtx.createAnalyser();
  state.analyser.fftSize = 2048;
  state.analyser.smoothingTimeConstant = 0.86;
  state.frequencyData = new Uint8Array(state.analyser.frequencyBinCount);
  state.waveformData = new Uint8Array(state.analyser.fftSize);

  state.sourceNode.connect(state.toneFilter);
  state.toneFilter.connect(state.analyser);
  state.analyser.connect(state.gainNode);
  state.gainNode.connect(state.audioCtx.destination);

  applyTone();
  applyVolume();
}

function canUseAudioGraphForUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function applyVolume() {
  const nextVolume = Number(volumeDial.value) / 100;
  if (state.useAudioGraph && state.gainNode) {
    state.gainNode.gain.value = nextVolume;
    audio.volume = 1;
    return;
  }
  audio.volume = nextVolume;
}

function applyTone() {
  if (!state.toneFilter) return;
  const pct = Number(toneDial.value) / 100;
  // 500Hz to 12kHz range gives audible "tone" shaping.
  const frequency = 500 + pct * 11500;
  state.toneFilter.frequency.value = frequency;
}

function getNextTrack(station) {
  const validTracks = station.tracks.filter(sanitizeTrack);
  if (!validTracks.length) return null;

  if (!state.isShuffle) {
    const lastIndex = state.lastTrackByStation[station.id] ?? -1;
    const nextIndex = (lastIndex + 1) % validTracks.length;
    state.lastTrackByStation[station.id] = nextIndex;
    return validTracks[nextIndex];
  }

  if (validTracks.length === 1) {
    state.lastTrackByStation[station.id] = 0;
    return validTracks[0];
  }

  let randomIndex = Math.floor(Math.random() * validTracks.length);
  const lastIndex = state.lastTrackByStation[station.id];
  while (randomIndex === lastIndex) {
    randomIndex = Math.floor(Math.random() * validTracks.length);
  }
  state.lastTrackByStation[station.id] = randomIndex;
  return validTracks[randomIndex];
}

async function playFromCurrentStation() {
  const station = getCurrentStation();
  if (!station) return;

  const track = getNextTrack(station);
  if (!track) {
    setStatus("No valid tracks in this station.", "warn");
    trackTitle.textContent = "-";
    trackMeta.textContent = `${station.name} has no valid URLs yet.`;
    return;
  }

  state.currentTrack = track;
  updateNowPlaying(track, station);
  audio.src = track.url;
  state.useAudioGraph = canUseAudioGraphForUrl(track.url);

  try {
    await initAudioGraph();
    await audio.play();
    state.consecutiveTrackErrors = 0;
    setStatus(`Live: ${station.name}`, "live");
    powerBtn.textContent = "Pause";
    state.isPoweredOn = true;
  } catch (err) {
    if (state.useAudioGraph) {
      // Fallback path: if CORS/graph init blocks playback, retry without analyzer graph.
      state.useAudioGraph = false;
      state.audioCtx = null;
      state.sourceNode = null;
      state.toneFilter = null;
      state.gainNode = null;
      state.analyser = null;
      state.frequencyData = null;
      state.waveformData = null;
      try {
        await audio.play();
        state.consecutiveTrackErrors = 0;
        setStatus(`Live: ${station.name}`, "live");
        helperText.textContent = "Audio graph unavailable for this track source. Using fallback visuals.";
        powerBtn.textContent = "Pause";
        state.isPoweredOn = true;
        return;
      } catch (_) {
        // Continue to normal autoplay warning below.
      }
    }
    setStatus("Click Power On to start audio.", "warn");
    helperText.textContent = "Your browser blocked autoplay. Press Power On again.";
    state.isPoweredOn = false;
    powerBtn.textContent = "Power On";
  }
}

function handleStationChange(index) {
  if (!state.stations.length) return;
  const clamped = Math.max(0, Math.min(state.stations.length - 1, index));
  state.stationIndex = clamped;
  stationDial.value = String(clamped);
  renderStationLabels();
  if (state.isPoweredOn) {
    playFromCurrentStation();
  } else {
    const station = getCurrentStation();
    trackMeta.textContent = `${station.name} selected. Press Power On.`;
  }
}

function updateStationPreviewFromSlider() {
  if (!state.stations.length) return;
  const nearest = Math.round(Number(stationDial.value));
  const clamped = Math.max(0, Math.min(state.stations.length - 1, nearest));
  if (clamped !== state.stationIndex) {
    state.stationIndex = clamped;
    renderStationLabels();
  }
}

function animateStationDialTo(targetIndex, onComplete) {
  const start = Number(stationDial.value);
  const end = Number(targetIndex);
  const durationMs = 220;
  const startedAt = performance.now();
  state.stationSnapAnimating = true;

  const tick = (now) => {
    const t = Math.min(1, (now - startedAt) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    stationDial.value = String(start + (end - start) * eased);
    updateStationPreviewFromSlider();
    if (t < 1) {
      requestAnimationFrame(tick);
      return;
    }
    stationDial.value = String(end);
    state.stationSnapAnimating = false;
    if (typeof onComplete === "function") onComplete();
  };

  requestAnimationFrame(tick);
}

function commitStationDialSelection() {
  if (!state.stations.length || state.stationSnapAnimating) return;
  const target = Math.max(0, Math.min(state.stations.length - 1, Math.round(Number(stationDial.value))));
  animateStationDialTo(target, () => handleStationChange(target));
}

function tuneToStation(index) {
  if (!state.stations.length || state.stationSnapAnimating) return;
  const target = Math.max(0, Math.min(state.stations.length - 1, index));
  animateStationDialTo(target, () => handleStationChange(target));
}

function togglePower() {
  if (audio.paused) {
    if (!state.currentTrack) {
      playFromCurrentStation();
      return;
    }

    Promise.resolve()
      .then(() => initAudioGraph())
      .then(() => audio.play())
      .then(() => {
        setStatus(`Live: ${getCurrentStation().name}`, "live");
        powerBtn.textContent = "Pause";
        state.isPoweredOn = true;
      })
      .catch(() => {
        setStatus("Unable to start playback.", "warn");
      });
    return;
  }

  audio.pause();
  powerBtn.textContent = "Power On";
  setStatus("Paused.");
  state.isPoweredOn = false;
}

function validateStationData(data) {
  if (!data || !Array.isArray(data.stations) || data.stations.length === 0) {
    throw new Error("stations.json must include at least one station.");
  }

  const normalized = data.stations.map((station, stationIndex) => ({
    id: station.id || `station-${stationIndex}`,
    name: station.name || `Station ${stationIndex + 1}`,
    tracks: Array.isArray(station.tracks) ? station.tracks : []
  }));

  return normalized;
}

function resizeScopeCanvas() {
  const rect = scopeCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  scopeCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  scopeCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  scopeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawIdleScope(width, height) {
  state.visualSeed += 0.025;
  scopeCtx.clearRect(0, 0, width, height);
  scopeCtx.fillStyle = "rgba(24, 46, 56, 0.86)";
  scopeCtx.fillRect(0, 0, width, height);

  scopeCtx.strokeStyle = "rgba(149, 206, 225, 0.2)";
  scopeCtx.lineWidth = 1;
  for (let y = 0; y < height; y += 26) {
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, y);
    scopeCtx.lineTo(width, y);
    scopeCtx.stroke();
  }

  const waveY = height / 2;
  scopeCtx.strokeStyle = "rgba(239, 171, 112, 0.7)";
  scopeCtx.lineWidth = 2;
  scopeCtx.beginPath();
  for (let x = 0; x <= width; x += 2) {
    const y = waveY + Math.sin(x * 0.015 + state.visualSeed) * 8;
    if (x === 0) scopeCtx.moveTo(x, y);
    else scopeCtx.lineTo(x, y);
  }
  scopeCtx.stroke();
}

function drawLiveScope(width, height) {
  if (!state.analyser || !state.frequencyData || !state.waveformData) {
    const t = audio.currentTime || 0;
    scopeCtx.clearRect(0, 0, width, height);
    scopeCtx.fillStyle = "rgba(18, 39, 48, 0.88)";
    scopeCtx.fillRect(0, 0, width, height);

    scopeCtx.strokeStyle = "rgba(149, 206, 225, 0.18)";
    scopeCtx.lineWidth = 1;
    for (let y = 0; y < height; y += 24) {
      scopeCtx.beginPath();
      scopeCtx.moveTo(0, y);
      scopeCtx.lineTo(width, y);
      scopeCtx.stroke();
    }

    const mid = height / 2;
    scopeCtx.strokeStyle = "rgba(239, 171, 112, 0.96)";
    scopeCtx.lineWidth = 2;
    scopeCtx.beginPath();
    for (let x = 0; x <= width; x += 2) {
      const y = mid + Math.sin(x * 0.02 + t * 4.8) * 12 + Math.sin(x * 0.008 + t * 1.8) * 7;
      if (x === 0) scopeCtx.moveTo(x, y);
      else scopeCtx.lineTo(x, y);
    }
    scopeCtx.stroke();

    state.eqBars.forEach((bar, index) => {
      const movement = 30 + Math.sin(t * 4 + index * 0.8) * 24 + Math.sin(t * 1.6 + index) * 10;
      bar.style.height = `${Math.max(10, Math.min(100, movement))}%`;
    });
    return;
  }

  state.analyser.getByteTimeDomainData(state.waveformData);
  state.analyser.getByteFrequencyData(state.frequencyData);

  scopeCtx.clearRect(0, 0, width, height);
  scopeCtx.fillStyle = "rgba(18, 39, 48, 0.88)";
  scopeCtx.fillRect(0, 0, width, height);

  scopeCtx.strokeStyle = "rgba(149, 206, 225, 0.18)";
  scopeCtx.lineWidth = 1;
  for (let y = 0; y < height; y += 24) {
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, y);
    scopeCtx.lineTo(width, y);
    scopeCtx.stroke();
  }

  scopeCtx.strokeStyle = "rgba(239, 171, 112, 0.96)";
  scopeCtx.lineWidth = 2;
  scopeCtx.beginPath();

  const step = state.waveformData.length / width;
  for (let x = 0; x < width; x += 1) {
    const idx = Math.floor(x * step);
    const value = state.waveformData[idx] / 255;
    const y = value * height;
    if (x === 0) scopeCtx.moveTo(x, y);
    else scopeCtx.lineTo(x, y);
  }
  scopeCtx.stroke();

  const barCount = state.eqBars.length;
  if (!barCount) return;
  const bucket = Math.floor(state.frequencyData.length / barCount) || 1;
  for (let i = 0; i < barCount; i += 1) {
    let total = 0;
    for (let j = 0; j < bucket; j += 1) {
      total += state.frequencyData[i * bucket + j] || 0;
    }
    const average = total / bucket;
    const heightPct = Math.max(8, Math.min(100, (average / 255) * 100));
    state.eqBars[i].style.height = `${heightPct}%`;
  }
}

function animateVisualizer() {
  const width = scopeCanvas.clientWidth;
  const height = scopeCanvas.clientHeight;
  if (state.isPoweredOn && !audio.paused) {
    drawLiveScope(width, height);
  } else {
    drawIdleScope(width, height);
    state.eqBars.forEach((bar, index) => {
      const idle = 14 + Math.sin(state.visualSeed + index * 0.7) * 6;
      bar.style.height = `${Math.max(8, idle)}%`;
    });
  }

  state.animationFrameId = requestAnimationFrame(animateVisualizer);
}

async function loadStations() {
  try {
    const response = await fetch("./stations.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load stations.json (${response.status})`);
    }
    const data = await response.json();
    state.stations = validateStationData(data);

    stationDial.max = String(state.stations.length - 1);
    stationDial.step = "0.01";
    stationDial.value = "0";
    stationDial.disabled = false;
    nextBtn.disabled = false;
    shuffleBtn.disabled = false;
    renderStationLabels();

    setStatus(`Ready: ${state.stations.length} stations loaded.`);
    helperText.textContent = "Press Power On to start Wrenasmir Wradio.";
  } catch (err) {
    setStatus("Could not load stations.", "warn");
    helperText.textContent = String(err.message);
  }
}

powerBtn.addEventListener("click", togglePower);

nextBtn.addEventListener("click", () => {
  if (!state.stations.length) return;
  playFromCurrentStation();
});

shuffleBtn.addEventListener("click", () => {
  state.isShuffle = !state.isShuffle;
  shuffleBtn.textContent = `Shuffle: ${state.isShuffle ? "On" : "Off"}`;
});

stationDial.addEventListener("input", (event) => {
  stationDial.value = String(Number(event.target.value));
  updateStationPreviewFromSlider();
});
stationDial.addEventListener("change", commitStationDialSelection);
stationDial.addEventListener("pointerup", commitStationDialSelection);
stationDial.addEventListener("touchend", commitStationDialSelection, { passive: true });

stationLabels.addEventListener("click", (event) => {
  const stationButton = event.target.closest(".station-label");
  if (!stationButton) return;
  const nextIndex = Number(stationButton.dataset.stationIndex);
  if (!Number.isFinite(nextIndex)) return;
  tuneToStation(nextIndex);
});

volumeDial.addEventListener("input", applyVolume);
toneDial.addEventListener("input", applyTone);

audio.addEventListener("ended", () => {
  playFromCurrentStation();
});

audio.addEventListener("error", () => {
  state.consecutiveTrackErrors += 1;
  const station = getCurrentStation();
  const stationTrackCount = station ? station.tracks.filter(sanitizeTrack).length : 0;
  const maxSkips = Math.max(2, Math.min(6, stationTrackCount || 2));

  if (state.consecutiveTrackErrors >= maxSkips) {
    audio.pause();
    state.isPoweredOn = false;
    powerBtn.textContent = "Power On";
    setStatus("Playback failed repeatedly for this station.", "warn");
    helperText.textContent =
      "Tracks are reachable, so this is likely a browser/CORS issue. Try another station or refresh.";
    return;
  }

  setStatus("Track failed to play. Scanning next...", "warn");
  playFromCurrentStation();
});

window.addEventListener("resize", resizeScopeCanvas);

buildEqBars();
resizeScopeCanvas();
applyVolume();
animateVisualizer();
loadStations();
