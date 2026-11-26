// Batch small capture blocks before AAC encoding. Windows' encoder falls behind on 10 ms inputs.
export class AudioBatch {
  constructor(frames, channels) {
    this.frames = frames; this.channels = channels; this.buffered = 0;
    this.samples = new Float32Array(frames * channels);
  }

  add(data, consume, frameOffset = 0, frameCount = data.numberOfFrames - frameOffset) {
    for (let offset = 0; offset < frameCount;) {
      const count = Math.min(frameCount - offset, this.frames - this.buffered);
      for (let c = 0; c < this.channels; c++) {
        data.copyTo(this.samples.subarray(c * this.frames + this.buffered, c * this.frames + this.buffered + count),
          { planeIndex: Math.min(c, data.numberOfChannels - 1), frameOffset: frameOffset + offset, frameCount: count, format: "f32-planar" });
      }
      this.buffered += count; offset += count;
      if (this.buffered === this.frames) this.flush(consume);
    }
  }

  addSilence(frameCount, consume) {
    for (let offset = 0; offset < frameCount;) {
      const count = Math.min(frameCount - offset, this.frames - this.buffered);
      for (let c = 0; c < this.channels; c++) {
        this.samples.fill(0, c * this.frames + this.buffered, c * this.frames + this.buffered + count);
      }
      this.buffered += count; offset += count;
      if (this.buffered === this.frames) this.flush(consume);
    }
  }

  flush(consume) {
    const count = this.buffered;
    if (!count) return;
    const samples = new Float32Array(count * this.channels);
    for (let c = 0; c < this.channels; c++) samples.set(this.samples.subarray(c * this.frames, c * this.frames + count), c * count);
    this.buffered = 0;
    consume(samples, count);
  }
}
