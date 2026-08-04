/* bounded block-matching interpolation worker for the opt-in radar prototype. */
'use strict';

function channelIndex(width, x, y) {
  return (y * width + x) * 4;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function luminance(pixels, index) {
  return pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
}

function sample(pixels, width, height, x, y) {
  var sourceX = clamp(Math.round(x), 0, width - 1);
  var sourceY = clamp(Math.round(y), 0, height - 1);
  var index = channelIndex(width, sourceX, sourceY);
  return [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
}

function estimateFlow(previous, next, width, height, x, y) {
  var bestX = 0;
  var bestY = 0;
  var bestScore = Infinity;
  for (var offsetY = -3; offsetY <= 3; offsetY += 1) {
    for (var offsetX = -3; offsetX <= 3; offsetX += 1) {
      var score = 0;
      for (var blockY = -1; blockY <= 1; blockY += 1) {
        for (var blockX = -1; blockX <= 1; blockX += 1) {
          var sourceX = clamp(x + blockX, 0, width - 1);
          var sourceY = clamp(y + blockY, 0, height - 1);
          var targetX = clamp(sourceX + offsetX, 0, width - 1);
          var targetY = clamp(sourceY + offsetY, 0, height - 1);
          var previousIndex = channelIndex(width, sourceX, sourceY);
          var nextIndex = channelIndex(width, targetX, targetY);
          score += Math.abs(luminance(previous, previousIndex) - luminance(next, nextIndex));
        }
      }
      if (score < bestScore) {
        bestScore = score;
        bestX = offsetX;
        bestY = offsetY;
      }
    }
  }
  return { x: bestX, y: bestY };
}

function interpolate(data) {
  var startedAt = typeof performance === 'object' && performance.now ? performance.now() : Date.now();
  var width = data.width;
  var height = data.height;
  var progress = Math.max(0, Math.min(1, Number(data.progress)));
  var previous = new Uint8ClampedArray(data.previous);
  var next = new Uint8ClampedArray(data.next);
  var output = new Uint8ClampedArray(previous.length);
  for (var y = 0; y < height; y += 1) {
    for (var x = 0; x < width; x += 1) {
      var flow = estimateFlow(previous, next, width, height, x, y);
      var previousColor = sample(previous, width, height, x - flow.x * progress, y - flow.y * progress);
      var nextColor = sample(next, width, height, x + flow.x * (1 - progress), y + flow.y * (1 - progress));
      var outputIndex = channelIndex(width, x, y);
      for (var channel = 0; channel < 4; channel += 1) {
        output[outputIndex + channel] = Math.round(previousColor[channel] * (1 - progress) + nextColor[channel] * progress);
      }
    }
  }
  var endedAt = typeof performance === 'object' && performance.now ? performance.now() : Date.now();
  self.postMessage({ ok: true, id: data.id, durationMs: Math.max(0, endedAt - startedAt), pixels: output.buffer }, [output.buffer]);
}

self.onmessage = function (event) {
  var data = event && event.data || {};
  if (data.type !== 'interpolate') return;
  try {
    if (!Number.isInteger(data.width) || !Number.isInteger(data.height) ||
        data.width <= 0 || data.height <= 0 || data.width * data.height > 128 * 72) {
      self.postMessage({ ok: false, id: data.id, reason: 'bounds' });
      return;
    }
    if (!data.previous || !data.next || data.previous.byteLength !== data.width * data.height * 4 ||
        data.next.byteLength !== data.width * data.height * 4) {
      self.postMessage({ ok: false, id: data.id, reason: 'input' });
      return;
    }
    interpolate(data);
  } catch (error) {
    self.postMessage({ ok: false, id: data.id, reason: 'worker', error: String(error && error.message || error) });
  }
};
