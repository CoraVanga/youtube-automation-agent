# Running the agent and using a local model

How to start and stop Lumen, what happens while it is not running, and how to point
text generation at a local Ollama server instead of a paid API.

## Starting and stopping

```bash
npm start
```

The dashboard is then at `http://localhost:3456`. The process stays in the foreground, so
**closing the terminal stops the agent**. Press `Ctrl+C` to stop it deliberately.

To keep it running after you close the terminal:

```bash
setsid nohup npm start > agent.log 2>&1 < /dev/null &
tail -f agent.log            # watch it
pkill -f "node index.js"     # stop it
```

`tmux` works just as well if you already use it: `tmux new -s agent`, run `npm start`,
detach with `Ctrl+B D`, return with `tmux attach -t agent`.

### After a reboot

The agent does **not** start itself. No service definition ships with the project, so you
run `npm start` again after every restart.

### What a stopped agent misses

The scheduler lives inside the process, so nothing is scheduled while it is down. The two
halves behave differently:

| Job | Schedule | If the agent was down |
|---|---|---|
| Publishing queue | every 15 min | **Catches up.** Every entry whose publish time has passed is picked up on the next sweep, so an approved video publishes late rather than never. |
| Content generation | 06:00 daily | Skipped for that day. No backfill. |
| Analytics collection | 09:00 daily | Skipped. |
| Optimization | 22:00 daily | Skipped. |
| Strategy review | Sundays 08:00 | Skipped. |
| Audience comment sync | every 4 hours | Skipped. |
| Growth experiment refresh | every 4 hours, on the half hour | Skipped. |
| Database maintenance | Saturdays 03:00 | Skipped. |

Approved, scheduled videos are therefore safe across a reboot. New content is not
generated for any day the machine was off.

## Where it listens

By default the server binds `127.0.0.1`, so only this machine can reach it. The dashboard
holds YouTube OAuth tokens and paid provider keys, which is why it is not exposed by
default.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3456` | Port to listen on. |
| `HOST` | `127.0.0.1` | Interface to bind. Setting anything else exposes the API to the network. |
| `API_KEY` | unset | Required in the `x-api-key` header. **Mandatory** when `HOST` is not loopback — the agent refuses to start without it. |
| `ALLOWED_HOSTS` | — | Extra hostnames accepted in the `Host` header, comma separated. Only needed behind a reverse proxy or tunnel. |

Mutating requests must also be same-origin; a cross-origin `Origin` or `Referer` is
rejected. Command-line clients that send neither header are unaffected.

## The dashboard API key

`npm run walkthrough` generates `API_KEY` into `.env` if one is not already set. The
dashboard asks for it once per browser and keeps it in that browser's local storage.

You need it for two things:

- Any request to the API from outside the dashboard (`curl`, scripts).
- **Changing provider credentials from the dashboard.** That route rejects the request
  when `API_KEY` is unset, even on a loopback bind, because another account on the same
  machine can still reach `127.0.0.1` and would otherwise be able to overwrite your
  provider with theirs.

Read the value out of `.env` when the browser prompts for it.

## What is configured where

| Credential | Dashboard | CLI |
|---|---|---|
| Channel name, goal, audience, voice, guardrails | ✅ Channel setup | ✅ |
| AI text provider and model (including Ollama) | ✅ Channel setup | ✅ |
| Narration keys (ElevenLabs, OpenAI, Gemini) | ✅ Channel setup | ✅ |
| Video provider keys (Replicate, MiniMax, Kling, DashScope) | ✅ Channel setup | ✅ |
| Which video provider to use | ✅ Channel setup | ✅ |
| **YouTube account** | ❌ | `npm run walkthrough` |

YouTube still runs through the CLI because connecting an account is an OAuth
redirect and a loopback callback rather than a pasted key.

Saving narration or video credentials in the dashboard requires a restart before the
pipeline uses them: those agents build their clients once at startup.

### Which narration provider runs

Narration has no selector. The generator takes the first provider that is completely
configured, in this order:

1. **ElevenLabs** — needs both an API key *and* a voice ID. A key alone is skipped.
2. **OpenAI TTS** — uses the same key as OpenAI text and images.
3. **Gemini TTS** — uses the same key as Gemini text and images.

If none of them is complete, narration is simulated, and a production with simulated
narration **cannot be approved, scheduled, or published**. The dashboard states which
provider will be used.

Azure Speech is not offered. Credentials for it can still be stored by older setup
flows, but no code path turns them into audio, so a setup relying on Azure alone
produces simulated narration.

## Using a local model with Ollama

Ollama replaces the **text** provider: scripts, strategy plans, SEO metadata, and comment
analysis. Those are the calls that run several times per video, so this is where API spend
concentrates.

It does **not** replace:

- **Narration (TTS)** — there is no local TTS path, and a production cannot be approved or
  published without real narration. Keep a TTS provider configured.
- **Image generation** — the built-in gradient slides are the free fallback.
- **YouTube upload** — always Google OAuth.

### Prerequisites

```bash
ollama serve                    # must be running
ollama pull <model>             # at least one model installed
```

Models tagged `:cloud` are hosted by Ollama rather than run locally, so they are not
offered as local options.

### Option A — the dashboard

Open **Channel setup → AI text provider**, choose **Ollama (local)**, confirm the server
address, and pick a model from the list read off the running server. Save.

If the agent is still in setup mode because other credentials are missing, the toast says
a restart is needed: agents are only built once credentials are complete, so a provider
chosen before that takes effect on the next start.

### Option B — the walkthrough

`npm run walkthrough` offers **Ollama (local)** alongside the cloud providers. It asks for
the address, lists installed models, asks about reasoning, and sends one real request to
confirm the model answers before saving.

### Option C — environment variables

```bash
# .env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=<model>
```

An explicit cloud key still takes precedence over these, so remove or comment out
`OPENAI_API_KEY` and friends if you want the local model to win.

### Reasoning models

Some models emit hidden reasoning before their answer, and that reasoning is charged
against the same token budget the agent allots for the response. With a reasoning model
left unchecked, the budget can be spent entirely on reasoning and the agent receives an
empty answer.

Turn on **Disable model reasoning** (the walkthrough asks the same question) for those
models. Note that Ollama's `think: false` only works on its native API — on the
OpenAI-compatible endpoint this project uses, `reasoning_effort: none` is the switch that
takes effect, and that is what the toggle sends.

If a model returns nothing and the log mentions reasoning, that toggle is the fix — not
the API key.

### Speed

A model larger than your VRAM still runs, with the overflow served from system RAM, but
noticeably slower. Mixture-of-experts models activate only a fraction of their parameters
per token and tend to be much faster than a dense model of the same file size. If
generation feels slow, compare a few installed models on a real run before concluding the
hardware is the limit.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `returned an empty response` naming reasoning | Reasoning model without the reasoning toggle on. |
| `Could not reach the local Ollama server` | `ollama serve` is not running, or the address is wrong. |
| `API_KEY must be set when HOST binds to a non-loopback address` | `HOST` was changed without setting `API_KEY`. |
| `Set API_KEY in .env to change provider credentials` | Editing providers in the dashboard requires `API_KEY`. |
| `Forbidden host` | The `Host` header is not loopback and not in `ALLOWED_HOSTS`. |
| Dashboard reachable from another machine | `HOST` is set to a non-loopback address. Unset it to return to local-only. |
| Nothing generated overnight | The agent was not running at 06:00. Fixed-time jobs do not backfill. |
