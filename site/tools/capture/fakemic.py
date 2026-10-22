"""A stand-in microphone for the voice clip scene (Linux, PipeWire).

The app records through ALSA's default device. In the capture home that device
is PipeWire's, pointed at a virtual source fed with a synthetic, speech-like
signal (no real microphone is opened), and its playback at a null sink (nothing
is heard). The nodes exist only while the scene runs.
"""

import math
import os
import random
import re
import struct
import subprocess
import time
import wave

from cap import WORK

FEED, MIC, SINK = "liber-capture-feed", "liber-capture-mic", "liber-capture-sink"

ASOUNDRC = f"""pcm.!default {{
  type pipewire
  capture_node "{MIC}"
  playback_node "{SINK}"
  hint {{ show on; description "Default" }}
}}
ctl.!default {{ type pipewire }}
"""


def voice_wav(path, seconds=60, rate=48000):
    """Voiced bursts at syllable rate, words and pauses: levels that move like speech."""
    if os.path.exists(path):
        return path
    random.seed(7)
    frames = bytearray()
    phase = 0.0
    for n in range(rate * seconds):
        t = n / rate
        word = (t % 2.6) < 1.9
        syl = 0.5 - 0.5 * math.cos(2 * math.pi * 4.3 * t)
        env = (syl**1.5) * (0.55 + 0.45 * math.sin(2 * math.pi * 0.37 * t)) if word else 0.0
        phase += 2 * math.pi * (140 + 25 * math.sin(2 * math.pi * 0.8 * t)) / rate
        v = sum(math.sin(k * phase) / k for k in range(1, 7))
        v = env * (0.5 * v + 0.15 * (random.random() - 0.5)) + 0.004 * (random.random() - 0.5)
        frames += struct.pack("<h", max(-32767, min(32767, int(v * 14000))))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return path


def _node_ids(name):
    out = subprocess.run(["pw-cli", "ls", "Node"], capture_output=True, text=True).stdout
    ids, current = [], None
    for line in out.splitlines():
        m = re.match(r"\s*id (\d+),", line)
        if m:
            current = int(m.group(1))
        elif f'node.name = "{name}"' in line and current is not None:
            ids.append(current)
    return ids


class FakeMic:
    """`with FakeMic() as mic: Session(..., files=mic.files, env=mic.env)`."""

    files = {".asoundrc": ASOUNDRC}

    @property
    def env(self):
        # The app reaches the user's PipeWire through its runtime dir; WebKit's
        # audio (GStreamer, via the Pulse protocol) plays into the null sink.
        return {"XDG_RUNTIME_DIR": os.environ["XDG_RUNTIME_DIR"], "PULSE_SINK": SINK}

    def __enter__(self):
        self.procs = []
        subprocess.run(
            ["pw-cli", "create-node", "adapter",
             "{ factory.name=support.null-audio-sink node.name=%s node.description=\"Liber capture sink\" "
             "media.class=Audio/Sink audio.position=[FL FR] object.linger=true }" % SINK],
            check=True, stdout=subprocess.DEVNULL,
        )
        self.procs.append(subprocess.Popen(
            ["pw-loopback", "-n", "liber-capture-loop", "-c", "1", "-m", "[MONO]",
             f"--capture-props=media.class=Audio/Sink node.name={FEED} audio.position=[MONO]",
             f"--playback-props=media.class=Audio/Source node.name={MIC} audio.position=[MONO]"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ))
        time.sleep(1.0)
        return self

    def speak(self):
        """Starts the signal (about a minute of it) into the virtual source."""
        os.makedirs(f"{WORK}/audio", exist_ok=True)
        wav = voice_wav(f"{WORK}/audio/voice.wav")
        feeder = subprocess.Popen(["pw-cat", "--playback", "--target", FEED, wav],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs.append(feeder)
        time.sleep(0.4)
        links = subprocess.run(["pw-link", "-l"], capture_output=True, text=True).stdout
        if re.search(r"pw-cat:output\S*\n\s+\|-> alsa_output", links):
            feeder.kill()  # it fell back to the speakers: never play out loud
            raise RuntimeError("the feeder didn't reach the virtual source")

    def __exit__(self, *exc):
        for p in reversed(self.procs):
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        for node in _node_ids(SINK):
            subprocess.run(["pw-cli", "destroy", str(node)], stdout=subprocess.DEVNULL)
