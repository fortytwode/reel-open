import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';

// Isolated synthetic codec smoke; loopback only, with no account or device capture.
app.whenReady().then(async () => {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><title>Reel codec smoke</title>');
  });
  let window;
  let exitCode = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Loopback smoke server did not bind a TCP port');
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
    await window.loadURL(`http://127.0.0.1:${address.port}/`);
    const result = await window.webContents.executeJavaScript(`(async () => {
      if (!globalThis.AudioEncoder || !globalThis.AudioDecoder || !globalThis.AudioData) throw Error('WebCodecs audio unavailable');
      const config = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, bitrate: 128000 };
      if (!(await AudioEncoder.isConfigSupported(config)).supported) throw Error('AAC encoder unavailable');
      const chunks = []; let decoderConfig, encoderError;
      const encoder = new AudioEncoder({ output: (chunk, metadata) => { chunks.push(chunk); decoderConfig ||= metadata.decoderConfig; }, error: error => { encoderError = error; } });
      encoder.configure(config);
      for (let b = 0; b < 48; b++) {
        const data = new Float32Array(1000);
        for (let i = 0; i < data.length; i++) data[i] = 0.3 * Math.sin(2 * Math.PI * 440 * (b * 1000 + i) / 48000);
        const frame = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: data.length, numberOfChannels: 1, timestamp: Math.round(b * 1000 * 1e6 / 48000), data });
        encoder.encode(frame); frame.close();
      }
      await encoder.flush(); encoder.close();
      if (encoderError || !chunks.length || !decoderConfig) throw Error('AAC encoding failed');
      let decoded = 0, energy = 0, decoderError;
      const decoder = new AudioDecoder({ output: frame => {
        const plane = new Float32Array(frame.numberOfFrames); frame.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
        for (const sample of plane) energy += sample * sample;
        decoded += plane.length; frame.close();
      }, error: error => { decoderError = error; } });
      decoder.configure(decoderConfig); for (const chunk of chunks) decoder.decode(chunk);
      await decoder.flush(); decoder.close();
      if (decoderError || decoded < 45000 || Math.sqrt(energy / decoded) < 0.05) throw Error('AAC decode or PCM failed');
      return { encodedChunks: chunks.length, decodedFrames: decoded };
    })()`);
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, ...result }));
  } catch (error) {
    console.error(String(error));
    exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    app.exit(exitCode);
  }
}).catch(error => { console.error(String(error)); app.exit(1); });
