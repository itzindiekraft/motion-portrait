(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.initScrubVideo = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /*
   Parse object-position CSS string like "70% center" or "50% 50%" into normalized [0, 1] offsets.
   */
  function parseObjectPosition(posStr) {
    if (!posStr || typeof posStr !== "string") {
      return { x: 0.7, y: 0.5 };
    }
    const tokens = posStr.trim().toLowerCase().split(/\s+/);
    const xToken = tokens[0] || "50%";
    const yToken = tokens[1] || "50%";

    function tokenToRatio(token, isVertical) {
      if (token === "center") return 0.5;
      if (token === "left") return 0.0;
      if (token === "right") return 1.0;
      if (token === "top") return 0.0;
      if (token === "bottom") return 1.0;
      if (token.endsWith("%")) {
        const val = parseFloat(token);
        return isNaN(val) ? 0.5 : Math.max(0, Math.min(1, val / 100));
      }
      return 0.5;
    }

    return {
      x: tokenToRatio(xToken, false),
      y: tokenToRatio(yToken, true),
    };
  }

  /*
    Resolve frame URL template. Supports "{fff}" (3-digit zero-padded), "{f}", or function.
   */
  function getFrameUrl(pattern, frameIndex1Based) {
    if (typeof pattern === "function") {
      return pattern(frameIndex1Based);
    }
    const padded3 = String(frameIndex1Based).padStart(3, "0");
    return pattern
      .replace(/\{fff\}/gi, padded3)
      .replace(/\{f\}/gi, String(frameIndex1Based))
      .replace(/\{frame\}/gi, String(frameIndex1Based));
  }

  /*
    Check if a URL refers to a video file instead of frame sequence
   */
  function isDirectVideoUrl(src) {
    if (typeof src !== "string") return false;
    return /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(src) && !/\{fff\}/i.test(src);
  }

  /*
    Main Initialization Function
    @param {Object} userConfig Configuration options
    @returns {Object} Controller object: { updateConfig, destroy, ... }
   */
  function initScrubVideo(userConfig = {}) {
    // 1. CONFIG DEFAULTS
    const config = {
      videoSrc: "./assets/ezgif-frame-{fff}.jpg",
      objectPosition: "70% center",
      sensitivity: 0.8,
      ease: 0.15,
      idleMs: 1200,
      neutral: 0.5,
      frameCount: 300,
      fps: 30,
      container: document.body,
      onProgress: null,
      onStatusChange: null,
      dprCap: 2, // Max devicePixelRatio to balance retina sharpness and 60fps throughput
      ...userConfig,
    };

    let parsedPosition = parseObjectPosition(config.objectPosition);
    const duration = config.frameCount / config.fps; // e.g. 300 / 30 = 10.0s
    let neutralTime = duration * config.neutral;

    // State variables
    let currentGaze = 0.0; // Normalized: -1.0 (Left), 0.0 (Center), +1.0 (Right)
    let targetGaze = 0.0;
    let currentTime = neutralTime;
    let targetTime = neutralTime;
    let isDestroyed = false;
    let isLoaded = false;
    let isIdle = true;
    let idleTimer = null;
    let prevX = null;
    let animationFrameId = null;
    let lastReportedStatus = "";
    let lastRenderedFrameIndex = -1;

    // Frames storage
    const frames = new Array(config.frameCount).fill(null);
    let loadedCount = 0;

    // DOM Elements
    let container = config.container;
    if (typeof container === "string") {
      container = document.querySelector(container) || document.body;
    }

    // ELEMENT CREATION & POSITIONING
    const isVideoFallback = isDirectVideoUrl(config.videoSrc);
    let canvas = null;
    let ctx = null;
    let videoFallback = null;

    if (isVideoFallback) {
      videoFallback = document.createElement("video");
      videoFallback.src = config.videoSrc;
      videoFallback.playsInline = true;
      videoFallback.muted = true;
      videoFallback.preload = "auto";
      videoFallback.style.position = "fixed";
      videoFallback.style.inset = "0";
      videoFallback.style.zIndex = "0";
      videoFallback.style.width = "100vw";
      videoFallback.style.height = "100vh";
      videoFallback.style.objectFit = "cover";
      videoFallback.style.objectPosition = config.objectPosition;
      videoFallback.style.pointerEvents = "none";
      container.appendChild(videoFallback);
    } else {
      canvas = document.createElement("canvas");
      canvas.id = "scrub-canvas";
      canvas.style.position = "fixed";
      canvas.style.inset = "0";
      canvas.style.zIndex = "0";
      canvas.style.width = "100vw";
      canvas.style.height = "100vh";
      canvas.style.pointerEvents = "none";
      canvas.style.display = "block";

      ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
      container.appendChild(canvas);
    }

    /*
     Notify status telemetry subscriber
     */
    function emitStatus(stateName, details = {}) {
      if (isDestroyed) return;
      const statusText =
        stateName || (isIdle ? "Center (Idle)" : "Following Cursor");

      let currentFrame;
      if (currentGaze <= 0) {
        currentFrame = Math.round(180 + currentGaze * (180 - 115));
      } else {
        currentFrame = Math.round(180 + currentGaze * (225 - 180));
      }
      currentFrame = Math.max(1, Math.min(config.frameCount, currentFrame));

      const telemetry = {
        status: statusText,
        currentGaze: Number(currentGaze.toFixed(3)),
        targetGaze: Number(targetGaze.toFixed(3)),
        currentFrame,
        totalFrames: config.frameCount,
        isIdle,
        isLoaded,
        progress: loadedCount / config.frameCount,
        ...details,
      };

      if (typeof config.onStatusChange === "function") {
        config.onStatusChange(telemetry);
      }
      lastReportedStatus = statusText;
    }

    /*
     Resize canvas buffer according to window and devicePixelRatio (Fixes pixel blur)
     */
    function resizeCanvas() {
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const displayW = window.innerWidth;
      const displayH = window.innerHeight;
      const bufferW = Math.round(displayW * dpr);
      const bufferH = Math.round(displayH * dpr);

      // Lock CSS dimensions to exact integer viewport pixels
      canvas.style.width = displayW + "px";
      canvas.style.height = displayH + "px";

      if (canvas.width !== bufferW || canvas.height !== bufferH) {
        canvas.width = bufferW;
        canvas.height = bufferH;
      }

      // Context state is reset on canvas resize - strictly enforce high quality interpolation
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      // Force redraw on resize
      lastRenderedFrameIndex = -1;
      drawCurrentFrame();
    }

    /*
     Draw frame image onto canvas adhering to object-fit: cover with object-position offset
     Crop in source pixels so every draw fills the canvas without rounded-edge gaps.
     */
    function drawImageCover(img) {
      if (!ctx || !canvas || !img) return;

      const cw = canvas.width;
      const ch = canvas.height;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;

      if (!iw || !ih) return;

      // Ensure high quality smoothing remains enabled
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      const scale = Math.max(cw / iw, ch / ih);
      const sourceW = cw / scale;
      const sourceH = ch / scale;
      const sx = (iw - sourceW) * parsedPosition.x;
      const sy = (ih - sourceH) * parsedPosition.y;

      ctx.drawImage(img, sx, sy, sourceW, sourceH, 0, 0, cw, ch);
    }

    /*
     Render the frame matching current gaze orientation
     */
    function drawCurrentFrame() {
      if (isVideoFallback) {
        if (videoFallback && videoFallback.readyState >= 2) {
          const ratio = (currentGaze + 1) / 2;
          videoFallback.currentTime = ratio * duration;
        }
        return;
      }

      if (!ctx || !canvas) return;

      // Calculate 0-based frame index from currentGaze:
      // currentGaze: -1.0 (Left, frame 115) -> 0.0 (Center, frame 180) -> +1.0 (Right, frame 225)
      let frameNum;
      if (currentGaze <= 0) {
        frameNum = Math.round(180 + currentGaze * (180 - 115));
      } else {
        frameNum = Math.round(180 + currentGaze * (225 - 180));
      }
      frameNum = Math.max(1, Math.min(config.frameCount, frameNum));
      const frameIndex = frameNum - 1;

      // Avoid re-drawing the exact same frame if canvas hasn't resized
      if (
        frameIndex === lastRenderedFrameIndex &&
        lastRenderedFrameIndex !== -1
      ) {
        return;
      }

      let frameImg = frames[frameIndex];

      // Use a valid neighboring frame while the requested image is loading.
      if (!frameImg || !frameImg.complete || !frameImg.naturalWidth) {
        frameImg = null;
        for (let i = frameIndex - 1; i >= 0; i--) {
          if (frames[i] && frames[i].complete && frames[i].naturalWidth) {
            frameImg = frames[i];
            break;
          }
        }
        if (!frameImg) {
          for (let i = frameIndex + 1; i < frames.length; i++) {
            if (frames[i] && frames[i].complete && frames[i].naturalWidth) {
              frameImg = frames[i];
              break;
            }
          }
        }
      }

      if (frameImg && frameImg.complete && frameImg.naturalWidth) {
        drawImageCover(frameImg);
        lastRenderedFrameIndex = frameIndex;
      }
    }

    // ZERO BLANK FLASH: POSTER IMAGE (Frame 180: Center facing pose)
    const posterUrl = getFrameUrl(config.videoSrc, 180);
    const posterImg = new Image();
    posterImg.crossOrigin = "anonymous";
    posterImg.src = posterUrl;
    frames[179] = posterImg;

    posterImg.onload = () => {
      if (isDestroyed) return;
      resizeCanvas();
      drawImageCover(posterImg);
      lastRenderedFrameIndex = 179;
    };

    // ANIMATION LOOP (LERP & RAF)
    function animate() {
      if (isDestroyed) return;

      // Smoothly bring targetGaze back to 0.0 (Center) when idle
      if (isLoaded && isIdle) {
        if (Math.abs(targetGaze) > 0.001) {
          targetGaze += (0.0 - targetGaze) * (config.ease * 0.5);
        } else {
          targetGaze = 0.0;
        }
      }

      // Lerp currentGaze toward targetGaze
      const diff = targetGaze - currentGaze;
      if (Math.abs(diff) > 0.0001) {
        currentGaze += diff * config.ease;
        drawCurrentFrame();
        emitStatus(isIdle ? "Returning to Center" : "Following Cursor");
      } else if (currentGaze !== targetGaze) {
        currentGaze = targetGaze;
        drawCurrentFrame();
        emitStatus(isIdle ? "Center (Resting)" : "Holding");
      }

      animationFrameId = requestAnimationFrame(animate);
    }

    // CURSOR-FOLLOWING & SCRUB LOGIC
    function resetIdleTimer() {
      if (isIdle) {
        isIdle = false;
        emitStatus("Following Cursor");
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        isIdle = true;
        targetGaze = 0.0; // Ease back to center
        emitStatus("Idle (Easing to Center)");
      }, config.idleMs);
    }

    function handlePointerMove(clientX) {
      if (!isLoaded || isDestroyed) return;

      // Map normalized cursor X position across window (-1.0 on left edge, +1.0 on right edge)
      const normalizedX = (clientX / window.innerWidth - 0.5) * 2;
      // Target gaze smoothly tracks cursor direction without inversion
      targetGaze = Math.max(
        -1.0,
        Math.min(1.0, normalizedX * config.sensitivity),
      );
      resetIdleTimer();
    }

    function onMouseMove(e) {
      handlePointerMove(e.clientX);
    }

    function onTouchStart(e) {
      if (e.touches && e.touches.length > 0) {
        prevX = e.touches[0].clientX;
        resetIdleTimer();
      }
    }

    function onTouchMove(e) {
      if (e.touches && e.touches.length > 0) {
        handlePointerMove(e.touches[0].clientX);
      }
    }

    function onTouchEnd() {
      prevX = null;
    }

    function onMouseLeave() {
      prevX = null;
    }

    function attachScrubEvents() {
      window.addEventListener("mousemove", onMouseMove, { passive: true });
      window.addEventListener("mouseleave", onMouseLeave, { passive: true });
      window.addEventListener("touchstart", onTouchStart, { passive: true });
      window.addEventListener("touchmove", onTouchMove, { passive: true });
      window.addEventListener("touchend", onTouchEnd, { passive: true });
      window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    }

    function detachScrubEvents() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    }

    window.addEventListener("resize", resizeCanvas, { passive: true });

    // LOADING & PRELOAD LOGIC (High concurrency with image.decode())
    function preloadAllFrames() {
      emitStatus("Preloading Frames", { progress: 0 });

      if (isVideoFallback) {
        videoFallback.addEventListener("loadeddata", () => {
          isLoaded = true;
          videoFallback.currentTime = neutralTime;
          attachScrubEvents();
          emitStatus("Ready");
        });
        return;
      }

      const total = config.frameCount;
      let completed = 0;

      // Concurrency batch manager to load images swiftly without blocking the network thread
      const CONCURRENCY = 12;
      let currentIndex = 1; // 1-based index
      let activeLoads = 0;

      function loadNextBatch() {
        if (isDestroyed) return;

        while (activeLoads < CONCURRENCY && currentIndex <= total) {
          const frameNum = currentIndex++;
          const idx = frameNum - 1;

          // Frame 180 was already created as poster
          const img = frameNum === 180 && posterImg ? posterImg : new Image();
          img.crossOrigin = "anonymous";
          frames[idx] = img;
          activeLoads++;
          let settled = false;

          const onSingleLoaded = () => {
            if (isDestroyed || settled) return;
            settled = true;
            activeLoads--;
            completed++;
            loadedCount = completed;

            const ratio = completed / total;
            if (typeof config.onProgress === "function") {
              config.onProgress(ratio, completed, total);
            }

            if (completed === total) {
              onAllLoaded();
            } else {
              loadNextBatch();
            }
          };

          if (img.complete && img.naturalWidth > 0) {
            onSingleLoaded();
          } else {
            img.onload = onSingleLoaded;
            img.onerror = () => {
              console.warn(
                `[ScrubEngine] Failed to load frame ${frameNum}: ${img.src}`,
              );
              onSingleLoaded();
            };
            img.src = getFrameUrl(config.videoSrc, frameNum);
          }
        }
      }

      function onAllLoaded() {
        isLoaded = true;
        currentGaze = 0.0;
        targetGaze = 0.0;

        // Draw initial center frame
        resizeCanvas();
        drawCurrentFrame();

        // Attach scrub event listeners only AFTER loading completes
        attachScrubEvents();

        emitStatus("Ready (Center Pose)", {
          currentGaze: 0.0,
          targetGaze: 0.0,
          progress: 1,
        });

        // Initialize idle timer
        resetIdleTimer();
      }

      loadNextBatch();
    }

    // Start loading sequence
    preloadAllFrames();

    // Start RAF loop
    resizeCanvas();
    animate();

    // 7. CONTROLLER API
    const controller = {
      /*
       Dynamically update parameters like sensitivity, ease, idleMs, neutral, objectPosition
       */
      updateConfig(newOpts = {}) {
        if (!newOpts || typeof newOpts !== "object") return;

        if (typeof newOpts.sensitivity === "number") {
          config.sensitivity = newOpts.sensitivity;
        }
        if (typeof newOpts.ease === "number") {
          config.ease = newOpts.ease;
        }
        if (typeof newOpts.idleMs === "number") {
          config.idleMs = newOpts.idleMs;
        }
        if (typeof newOpts.neutral === "number") {
          config.neutral = Math.max(0, Math.min(1, newOpts.neutral));
          neutralTime = duration * config.neutral;
        }
        if (typeof newOpts.objectPosition === "string") {
          config.objectPosition = newOpts.objectPosition;
          parsedPosition = parseObjectPosition(config.objectPosition);
          if (videoFallback) {
            videoFallback.style.objectPosition = config.objectPosition;
          }
          lastRenderedFrameIndex = -1;
          drawCurrentFrame();
        }
        if (typeof newOpts.onStatusChange === "function") {
          config.onStatusChange = newOpts.onStatusChange;
        }
        if (typeof newOpts.onProgress === "function") {
          config.onProgress = newOpts.onProgress;
        }
      },

      /*
       Clean up elements, event listeners, and timers
       */
      destroy() {
        isDestroyed = true;
        clearTimeout(idleTimer);
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
        }
        detachScrubEvents();
        window.removeEventListener("resize", resizeCanvas);

        if (canvas && canvas.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
        if (videoFallback && videoFallback.parentNode) {
          videoFallback.parentNode.removeChild(videoFallback);
        }
        frames.length = 0;
      },

      /*
       Seek programmatically
       */
      seekTo(timeInSeconds) {
        targetTime = Math.max(0, Math.min(duration, timeInSeconds));
        resetIdleTimer();
      },

      seekToFrame(frameNumber1Based) {
        const ratio = (frameNumber1Based - 1) / (config.frameCount - 1);
        targetTime = Math.max(0, Math.min(duration, ratio * duration));
        resetIdleTimer();
      },

      /*
       State accessors
       */
      getCurrentTime: () => currentTime,
      getTargetTime: () => targetTime,
      getDuration: () => duration,
      isLoaded: () => isLoaded,
      getConfig: () => ({ ...config }),
      getCanvas: () => canvas || videoFallback,
    };

    return controller;
  }

  return initScrubVideo;
});
