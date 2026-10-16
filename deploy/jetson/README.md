# Jetson deployment

The compose stack runs five isolated processes: API, the main llama.cpp server, a small vision
llama.cpp server, faster-whisper, and Kokoro.
The API is Python 3.8.10, faster-whisper uses the Python supplied by the selected L4T image,
Kokoro uses Python 3.12, and llama.cpp is C++. Speech package requirements therefore do not
constrain the public API or any future Python application in the monorepo.

## Models

Expected mounted files:

```text
models/
  llm/qwen3-30b-a3b-instruct-2507-q4_k_m.gguf
  llm/qwen3-30b-a3b-instruct-2507-heretic-q4_k_m.gguf
  vision/Qwen3VL-4B-Instruct-Q4_K_M.gguf
  vision/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf
  kokoro/kokoro-v1.0.onnx
  kokoro/voices-v1.0.bin
  whisper/                         Hugging Face cache, populated on first start
```

Download the pinned Qwen and Kokoro artifacts with checksum verification:

```bash
make jetson-models
```

The faster-whisper model is stored in `models/whisper/` automatically on first start.

The default LLM experiment is the Heretic (abliterated) build of
Qwen3-30B-A3B-Instruct-2507 at Q4_K_M, selected with `JARVIS_LLM_VARIANT=heretic`.
Only about 3B parameters are active per token, which is a strong speed/reasoning
compromise for a 64 GB AGX Orin. Flip back to the stock Instruct weights without
redeploying code:

```bash
# In /mnt/ssd/jarvis/.env
JARVIS_LLM_VARIANT=stock
# then: docker compose -f deploy/jetson/compose.yml up -d --force-recreate --no-deps llm api
```

Set `JARVIS_LLM_VARIANT=heretic` again to restore the experiment. Optional
`JARVIS_LLM_MODEL` / `LLM_MODEL_FILE` overrides still win when set. The default ASR
model is `distil-large-v3`; ASR completes before LLM generation begins, so it can use the GPU
without competing with token generation. Model filenames and context size are environment
settings so the target can be benchmarked without API changes.

On-demand camera description uses Qwen3-VL-4B-Instruct Q4_K_M with the Q8 vision projector on
port 8083. Keeping this comparatively small model resident makes `describe_scene` responsive
without bloating the main agent context or introducing a cloud vision dependency.

## JetPack matching

The current `jarvis-api.local` host runs JetPack 5 / L4T 35.4.1 with CUDA 11.4 and cuDNN 8. The ASR
image therefore pins CTranslate2 3.24 and faster-whisper 0.10, the newest mutually compatible
line for that GPU ABI. Containers isolate package versions, but they cannot make a CUDA 12
userspace compatible with a CUDA 11 host driver. `L4T_BASE_IMAGE` remains configurable for a
future host upgrade. The API remains Python 3.8.10 either way, and Kokoro independently uses
Python 3.12.

The pinned llama.cpp server uses a 32k context, Q8 key cache, F16 value cache, and disables flash
attention. Flash attention plus quantized values triggers an illegal CUDA memory access on this
JetPack 5 Orin; the conservative path has been validated with normal generation and native tool
calls.

Build on the Jetson itself so llama.cpp and CTranslate2 compile for compute capability 8.7:

```bash
cp .env.example .env
docker compose -f deploy/jetson/compose.yml build
docker compose -f deploy/jetson/compose.yml up -d
```

Jetson inference builds can run for hours. Keep interactive work in `tmux` (`tmux new -s
jarvis-build`, detach with `Ctrl-b d`, and resume with `tmux attach -t jarvis-build`). For fully
unattended builds, run Compose in a transient systemd unit with absolute paths and follow it with
`journalctl -fu jarvis-build`:

```bash
sudo systemd-run --no-block --unit=jarvis-build --collect --property=Type=oneshot \
  /usr/bin/docker compose --env-file /mnt/ssd/jarvis/.env \
  -f /mnt/ssd/jarvis/deploy/jetson/compose.yml build
```

All containers use an `always` restart policy and expose Docker health checks. The API waits
for healthy inference services on a full-stack start, but the services remain independent after
startup. To rebuild and replace only the API without touching loaded models, run:

```bash
make jetson-api-deploy
```

For boot-time reconciliation in addition to Docker's restart policy, install the supplied unit:

```bash
sudo install -m 0644 deploy/jetson/jarvis.service /etc/systemd/system/jarvis.service
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis.service
```

All five services use Linux host networking. The API listens on all interfaces at port 8000; the
main LLM, vision LLM, faster-whisper, and Kokoro bind only to loopback on ports 8080, 8083, 8091,
and 8092. Host networking is intentional: the API needs direct access to the home network to
reach Home Assistant and the voice devices, while the inference services must remain private.

Docker still injects `/etc/resolv.conf` into host-network containers. On this Jetson,
systemd-resolved leaves Docker's generated resolv.conf without nameservers, which breaks
outbound DNS inside the API (Google ID token verification, Gmail, etc.). Compose mounts
`/etc/docker-resolv-jarvis.conf` over the container resolv.conf. Create it once on the host:

```bash
printf 'nameserver 127.0.0.53\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n' | \
  sudo tee /etc/docker-resolv-jarvis.conf
```

The Jetson also advertises `jarvis-api.local` with Avahi. Restrict Avahi to the physical LAN
interfaces so Docker bridges cannot create a self-conflict during boot. Add this line under
`[server]` in `/etc/avahi/avahi-daemon.conf`, then restart Avahi:

```ini
allow-interfaces=wlan0,eth0
```

For a dedicated, adequately cooled AGX Orin developer kit, enable the stock dynamic MAXN profile:

```bash
sudo nvpmodel -m 0
```

The current `jarvis-api.local` target is configured this way. MAXN alone is not enough for the
lowest voice latency: the GPU devfreq governor never fully ramps for the short generation bursts
a voice turn produces, and the measured decode rate for a fresh 30B server roughly doubles (about
15 to about 30 tokens per second on short bursts) when clocks are pinned. Pinning clocks raises
idle power and fan noise on an always-on box, so it is an optional trade-off. To pin clocks at
boot, install the supplied unit:

```bash
sudo install -m 0644 deploy/jetson/jarvis-clocks.service /etc/systemd/system/jarvis-clocks.service
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-clocks.service
```

## Host memory tuning

The default `vm.swappiness=60` lets the kernel page out idle anonymous memory of the long-running
inference processes. Over a day of uptime this degraded llama.cpp decode from about 30 to about
5 tokens per second (roughly 200 ms per token) until the container was restarted, which turned a
few-second voice command into a 30-second one. Prefer dropping page cache over swapping the
inference services:

```bash
echo "vm.swappiness=10" | sudo tee /etc/sysctl.d/99-jarvis-swappiness.conf
sudo sysctl -w vm.swappiness=10
```

If a voice turn suddenly feels slow, check the decode rate in the LLM logs
(`docker logs jarvis-llm-1 2>&1 | grep "eval time" | tail`) and the per-process swap use
(`grep VmSwap /proc/$(pgrep -f "llama-server.*8080")/status`); a swapped-out `llama-server` or
ASR process recovers after `docker restart jarvis-llm-1 jarvis-asr-1`.

Set `JARVIS_GOOGLE_REDIRECT_URI` to an address a browser can reach on the Jetson if Gmail is
enabled. `JARVIS_CORS_ORIGINS` must include both Cloud Run hostnames assigned to the Expo service
(the generated-hash `a.run.app` URL and the project-number `run.app` URL); browsers may use either
for the same deployed revision.

Set `JARVIS_HOME_ASSISTANT_URL` to Home Assistant's LAN address, not an mDNS name: the API
container cannot resolve `.local` names. `JARVIS_HOME_ASSISTANT_TOKEN` is a long-lived access
token created in Home Assistant and belongs in the Jetson's `.env` only. Vendor credentials such
as the Govee API key now live in Home Assistant, not in Jarvis.
## Public ngrok tunnel

Install `jarvis-ngrok.service` into `/etc/systemd/system/` and enable it with
`sudo systemctl enable --now jarvis-ngrok.service`. It uses the reserved
`jarvis-api.example.com` hostname and forwards directly to the Jetson API on
port 8000. Do not run the same account tunnel on the Mac mini; the Expo web deployment uses this
address as its browser-reachable API URL.
