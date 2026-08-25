/* ============================================================
   KBEL Radio Player  (volume-crossfade edition)
   - Loads content.json
   - Builds a fresh randomized playlist on every page load
   - Crossfades between tracks using each <audio> element's own
     .volume (no Web Audio / no createMediaElementSource, so it
     works on plain static hosting without CORS headers)
   - Updates the "NOW PLAYING" UI in index.html
   ============================================================ */

(() => {
  "use strict";

  // ---- Config ----------------------------------------------------
  const CONTENT_URL = "content.json";
  const CROSSFADE_SECONDS = 1.5;   // overlap length between songs
  const FADE_TICK_MS = 50;       // volume ramp resolution
  const TARGET_VOLUME = 1.0;     // max volume per deck (0..1)
  const POLL_MS = 250;           // how often we check remaining time
  const DEBUG = false;           // set true to trace in console

  function log(...a) { if (DEBUG) console.log("[KBEL]", ...a); }

  // ---- State -----------------------------------------------------
  let station = null;
  let playlist = [];
  let queueIndex = 0;
  let isPlaying = false;
  let started = false;

  // Two decks: one plays while the other fades in.
  const decks = [createDeck(), createDeck()];
  let activeDeck = 0;

  function createDeck() {
    return {
      audio: null,
      track: null,
      poll: null,        // remaining-time poll timer
      fade: null,        // volume ramp interval
      retire: null,      // delayed teardown timer
      crossfading: false // has this deck already handed off?
    };
  }

  // ---- Utilities -------------------------------------------------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function trackUrl(track) {
    const base = (station && station.audioBase) || "";
    if (/^https?:\/\//i.test(track.file)) return track.file;
    const encoded = track.file.split("/").map(encodeURIComponent).join("/");
    return base + encoded;
  }

  function nextTrack() {
    if (playlist.length === 0) return null;
    const track = playlist[queueIndex % playlist.length];
    queueIndex++;
    if (queueIndex % playlist.length === 0) {
      playlist = shuffle(playlist); // reshuffle each full pass
    }
    return track;
  }

  // ---- UI --------------------------------------------------------
  function updateNowPlaying(track) {
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    setText("now-playing", track.title + " - " + track.artist);
    setText("np-title", track.title);
    setText("np-artist", track.artist);
    setText("np-album", track.album || "");

    const artEl = document.getElementById("np-art");
    if (artEl && track.art) {
      if (artEl.tagName === "IMG") artEl.src = track.art;
      else artEl.style.backgroundImage = "url('" + track.art + "')";
    }
    document.title = "\u266A " + track.title + " \u2014 KBEL";
  }

  function setListenButtons(playing) {
    document.querySelectorAll("[data-listen-btn], #listenBtn").forEach((btn) => {
      const icon = playing ? "fa-pause" : "fa-play";
      const label = playing ? "NOW PLAYING" : "LISTEN LIVE";
      btn.innerHTML = '<i class="fas ' + icon + '"></i> ' + label;
      btn.classList.toggle("bg-red-500", playing);
      btn.classList.toggle("hover:bg-red-600", playing);
    });
  }

  // ---- Volume fade (setInterval ramp on the element itself) -------
  function rampVolume(deck, to, seconds, onDone) {
    clearInterval(deck.fade);
    const audio = deck.audio;
    if (!audio) return;
    const from = audio.volume;
    const steps = Math.max(1, Math.round((seconds * 1000) / FADE_TICK_MS));
    let step = 0;
    deck.fade = setInterval(() => {
      step++;
      const t = step / steps;
      let v = from + (to - from) * t;
      v = Math.min(1, Math.max(0, v));
      try { audio.volume = v; } catch (e) {}
      if (step >= steps) {
        clearInterval(deck.fade);
        deck.fade = null;
        if (onDone) onDone();
      }
    }, FADE_TICK_MS);
  }

  // ---- Playback --------------------------------------------------
  function playTrackOn(deckIndex, track) {
    const deck = decks[deckIndex];
    clearTimers(deck);
    deck.crossfading = false;
    deck.track = track;

    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = 0;
    audio.src = trackUrl(track);
    deck.audio = audio;

    log("load deck", deckIndex, track.title, audio.src);
    updateNowPlaying(track);

    let startedThisTrack = false;
    const startPlayback = () => {
      if (startedThisTrack) return;
      startedThisTrack = true;
      const p = audio.play();
      if (p && p.catch) p.catch((e) => log("play() rejected", e && e.name));
      rampVolume(deck, TARGET_VOLUME, CROSSFADE_SECONDS);
      scheduleCrossfade(deckIndex);
    };

    audio.addEventListener("canplay", startPlayback, { once: true });
    audio.addEventListener("loadedmetadata", () => log("meta", track.title, "dur", audio.duration));

    // If the file genuinely fails to load, skip forward — but only once,
    // and only for THIS deck while it is the active one.
    audio.addEventListener("error", () => {
      log("error on", track.title, audio.error && audio.error.code);
      if (isPlaying && activeDeck === deckIndex && !deck.crossfading) {
        skipToNext(deckIndex);
      }
    }, { once: true });

    // Kick playback if it's already ready.
    if (audio.readyState >= 3) startPlayback();
  }

  function scheduleCrossfade(deckIndex) {
    const deck = decks[deckIndex];
    const audio = deck.audio;

    const check = () => {
      if (!isPlaying || activeDeck !== deckIndex || deck.crossfading) return;
      const dur = audio.duration;
      if (isFinite(dur) && dur > 0) {
        const remaining = dur - audio.currentTime;
        if (remaining <= CROSSFADE_SECONDS) {
          beginCrossfade(deckIndex);
          return;
        }
      }
      deck.poll = setTimeout(check, POLL_MS);
    };
    clearTimeout(deck.poll);
    deck.poll = setTimeout(check, POLL_MS);

    // Real end-of-track safety net (fires once).
    audio.addEventListener("ended", () => {
      if (isPlaying && activeDeck === deckIndex && !deck.crossfading) {
        beginCrossfade(deckIndex);
      }
    }, { once: true });
  }

  // Smooth handoff with overlap. Guarded so it runs once per track.
  function beginCrossfade(fromDeckIndex) {
    const outgoing = decks[fromDeckIndex];
    if (outgoing.crossfading) return;
    outgoing.crossfading = true;
    clearTimeout(outgoing.poll);

    const track = nextTrack();
    if (!track) { outgoing.crossfading = false; return; }

    const toDeckIndex = fromDeckIndex === 0 ? 1 : 0;
    log("crossfade", fromDeckIndex, "->", toDeckIndex, "next:", track.title);

    // Fade the outgoing one out, then tear it down.
    rampVolume(outgoing, 0, CROSSFADE_SECONDS, () => stopDeck(fromDeckIndex));
    clearTimeout(outgoing.retire);
    outgoing.retire = setTimeout(() => stopDeck(fromDeckIndex), (CROSSFADE_SECONDS + 1) * 1000);

    // Bring the next one in.
    activeDeck = toDeckIndex;
    playTrackOn(toDeckIndex, track);
  }

  // Hard skip (no overlap) — used only on load errors.
  function skipToNext(fromDeckIndex) {
    const deck = decks[fromDeckIndex];
    if (deck.crossfading) return;
    deck.crossfading = true;
    stopDeck(fromDeckIndex);
    const track = nextTrack();
    if (!track) return;
    activeDeck = fromDeckIndex === 0 ? 1 : 0;
    playTrackOn(activeDeck, track);
  }

  function clearTimers(deck) {
    clearTimeout(deck.poll);
    clearTimeout(deck.retire);
    clearInterval(deck.fade);
    deck.poll = deck.retire = deck.fade = null;
  }

  function stopDeck(deckIndex) {
    const deck = decks[deckIndex];
    clearTimers(deck);
    if (deck.audio) {
      try { deck.audio.pause(); } catch (e) {}
      deck.audio.removeAttribute("src");
      try { deck.audio.load(); } catch (e) {}
    }
    deck.audio = null;
    deck.track = null;
    deck.crossfading = false;
  }

  // ---- Controls --------------------------------------------------
  function start() {
    if (!started) {
      started = true;
      isPlaying = true;
      const track = nextTrack();
      if (track) playTrackOn(activeDeck, track);
    } else {
      resume();
    }
    setListenButtons(true);
  }

  function pause() {
    isPlaying = false;
    decks.forEach((d) => { if (d.audio) { try { d.audio.pause(); } catch (e) {} } });
    setListenButtons(false);
  }

  function resume() {
    isPlaying = true;
    decks.forEach((d) => {
      if (d.audio) {
        const p = d.audio.play();
        if (p && p.catch) p.catch(() => {});
      }
    });
    setListenButtons(true);
  }

  function togglePlay() {
    if (!started || !isPlaying) start();
    else pause();
  }

  window.togglePlay = togglePlay;
  window.KBEL = { start, pause, togglePlay, next: () => skipToNext(activeDeck) };

  // ---- Boot ------------------------------------------------------
  async function init() {
    try {
      const res = await fetch(CONTENT_URL, { cache: "no-store" });
      const data = await res.json();
      station = data.station || {};
      playlist = shuffle(data.tracks || []);
      queueIndex = 0;
      if (playlist.length) updateNowPlaying(playlist[0]);
      log("loaded", playlist.length, "tracks, base:", station.audioBase);
    } catch (err) {
      console.error("KBEL: failed to load playlist", err);
      const np = document.getElementById("now-playing");
      if (np) np.textContent = "Playlist unavailable";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();