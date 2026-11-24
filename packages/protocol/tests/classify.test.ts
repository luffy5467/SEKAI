import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyLink, parseYouTubeId } from '../src/classify.ts';

const entry = (input: string) => {
  const result = classifyLink(input);
  assert.ok(result.ok, `expected ${input} to classify`);
  return result.entry;
};

describe('parseYouTubeId (mirrors util::parse_video_id)', () => {
  it('reads every common shape', () => {
    for (const input of [
      'dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=42',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ]) {
      assert.equal(parseYouTubeId(input), 'dQw4w9WgXcQ', input);
    }
  });

  it('rejects near misses', () => {
    assert.equal(parseYouTubeId('https://youtu.be/short'), null);
    assert.equal(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  });
});

describe('classifyLink (mirrors media::classify)', () => {
  it('classifies YouTube with a canonical URL', () => {
    const e = entry('https://youtu.be/dQw4w9WgXcQ');
    assert.equal(e.kind, 'youtube');
    assert.equal(e.videoId, 'dQw4w9WgXcQ');
    assert.equal(e.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('classifies files, HLS and DASH by extension, with a filename title', () => {
    assert.equal(entry('https://cdn.example.com/My%20Film.mp4').kind, 'file');
    assert.equal(entry('https://cdn.example.com/My%20Film.mp4').title, 'My Film.mp4');
    assert.equal(entry('https://cdn.example.com/live/index.m3u8').kind, 'hls');
    assert.equal(entry('https://cdn.example.com/stream.mpd').kind, 'dash');
    assert.equal(entry('https://cdn.example.com/stream').kind, 'file');
  });

  it('adds https to a bare host', () => {
    assert.equal(entry('example.com/clip.webm').url, 'https://example.com/clip.webm');
  });

  it('canonicalises Twitch and Kick', () => {
    assert.equal(entry('https://twitch.tv/SomeChannel').url, 'https://www.twitch.tv/somechannel');
    assert.equal(
      entry('https://www.twitch.tv/videos/123456').url,
      'https://www.twitch.tv/videos/123456',
    );
    assert.equal(entry('https://kick.com/SomeOne').url, 'https://kick.com/someone');
    assert.equal(classifyLink('https://twitch.tv/directory').ok, false);
  });

  it('refuses playlists, which need server-side import', () => {
    assert.deepEqual(classifyLink('https://example.com/channels.m3u'), {
      ok: false,
      reason: 'playlist',
    });
  });

  it('refuses non-http schemes and junk', () => {
    for (const bad of [
      '',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:video/mp4;base64,AA',
      'not a link',
      'https://user:pw@example.com/a.mp4',
    ]) {
      assert.equal(classifyLink(bad).ok, false, bad);
    }
  });
});
