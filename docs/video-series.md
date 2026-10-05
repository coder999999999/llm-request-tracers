# One Request, Traced: video series

Working notes for the explainer videos that sit on this site. Read this before you touch `video/`, the "short version" section of `index.html`, or anything that links a tracer to a video.

## What the series is

*One Request, Traced* is a short explainer series. It follows a single streaming chat request (`POST /v1/chat/completions`, "Why is the sky blue?", `"stream": true`) through two real inference servers, llama.cpp and vLLM, one stage at a time.

- **Who it is for:** developers who run or self-host models and want to know what the server is doing. It is also a portfolio piece.
- **The promise:** each episode answers one question you could ask about your own request, and ends on a moment where you watch the answer happen.
- **The rule:** every on-screen function name, file:line and number matches the tracer's source at its pinned commit (llama.cpp `2ca15f5`, vLLM `1388100`). If a number can't be sourced, it stays off screen.
- **The relationship to this repo:** each video is a door into a tracer, not a replacement for it. Every episode ends by pointing to the tracer, and the tracer pages should embed or link their episode.

## Episode lineup

| # | Title | Question it answers | Payoff on screen | Engine | Length | Status |
|---|---|---|---|---|---|---|
| T | One Request, Traced | Why watch? | A word appears, then the trip rewinds behind it | Both | 20 s | Planned |
| 1 | The Trip | What happens between pressing Enter and the first word? | The board pulls back into one map of the hot path | llama.cpp | 1:44 | **Done, 16:9 on the site.** 9:16 not rendered yet |
| 2 | Warm Start | Why is my second message faster? | Turn two lands in the same slot and skips most of its prompt work | llama.cpp | ~90 s | Next |
| 3 | One Word | How does the model pick the next word? | 128,256 scores shrink to a handful, then one is drawn | llama.cpp | ~75 s | Planned |
| 4 | Many Chats, One GPU | How does one GPU serve many people at once? | Requests join and leave the batch every tick; KV cache paged into blocks | vLLM | ~90 s | Planned |
| 5 | Two Engines | How do llama.cpp and vLLM differ on the same request? | Split screen: one process with slots vs two processes over ZMQ | Both | ~100 s | Planned |

Each episode ends with a one-line tease for the next, so the series plays in order but each episode stands alone.

## Episode 1, "The Trip" (current video)

File: `video/llama-cpp-request-trace.mp4` (1920×1080, 30 fps, 1:44, H.264 + AAC, about 27 MB). Captions: `video/llama-cpp-request-trace.en.vtt`.

It replaced the earlier 60-second pilot, which used the same collage look but a weaker synthetic voice (Kokoro-82M) and a flat eleven-step tour.

Structure: a cold open, then four acts. Each act opens on a torn-paper act card.

| Part | Tracer stages covered | Key beat |
|---|---|---|
| Cold open | none | "Why is the sky blue?" is typed; a stopwatch, the word "The" appears, then the trip rewinds "slowed way down". Then the series ident. |
| Act I · Arrive | 01 HTTP worker thread, 02 chat template, 03 tokenizer | The jack for `/v1/chat/completions` lights up; the prompt strip is cut into 16 token chips (BOS added). |
| Act II · Wait | 04 task queue, 05 slot scheduler | The task drops into a pneumatic tube and lands in slot 0. |
| Act III · Think | 06 batch + KV cache, 07 graph build, 08 GPU compute, 09 sampling | Batch chips, KV cells fill; 32 layer sheets; GPU flash; the lottery drum draws " The". |
| Act IV · Speak | 10 SSE stream, 11 stop + release | The decode loop runs as a violet thread lapping the board; STOP stamp; the slot goes idle but keeps its cache. |
| End | none | Pull back over the whole board, tease "Next: Warm Start", end card. |

The narration script (display text and spoken phonetics) and the word timings live in the production workspace, not this repo. The VTT here holds the final captions.

Known gaps:
- The 9:16 vertical cut is designed and previewed but not rendered. Its layout: a header band with series, episode, act and step progress; a square window onto the board that pans per beat; and a large caption band.
- The candidate probabilities in the sampling scene (0.61, 0.12, ...) are illustrative and labelled that way on screen.

## Shared look (keep consistent across episodes)

- **Collage:** Victorian engravings and halftone photos, cut out like paper and printed in riso-style inks on cream stock. Each stage gets one object that does explanatory work:

  | Stage | Object |
  |---|---|
  | Routing | Switchboard operator |
  | Typing the prompt | Typewriter |
  | Tokenizing | Scissors |
  | Queue | Pneumatic tube |
  | Slots | Pigeonhole cabinet |
  | KV cache | Card catalogue |
  | Sampling | Lottery drum |
  | Streaming | Ticker tape |
  | Stop | Clouds |
  | Latency | Stopwatch |

- **The thread:** the request is an amber thread pinned at every stage, matching the tracers' hot-path colour. The decode loop is a second, violet thread. vLLM episodes add a dashed process boundary the thread has to cross.
- **Lane colours:** the same as the tracers. Teal HTTP, blue parse/tokenize, violet queue, magenta slots, orange batch/KV, green graph, cyan GPU, pink sampling, mint response, red stop.
- **Step cards:** a dark card in the tracers' own style names the real function and file:line whenever the narration names a stage.
- **Type:** Instrument Serif for display, IBM Plex Mono for code, IBM Plex Sans Condensed for labels, Caveat for handwritten notes.
- **Paper per engine:** llama.cpp episodes on cream stock, vLLM episodes on kraft, the finale on both halves of one sheet.

## Voice and sound

- **Narrator:** ElevenLabs v4, voice "Jack John – Conversational and Upbeat", directed warmer with inline tags such as `[warm, curious]` and `[softly, leaning in]`. It was picked after a blind audition against open models (Kokoro, VoxCPM2, Chatterbox, Qwen TTS); those sounded noticeably synthetic. Keep this voice for every episode.
- **Delivery:** second person ("your message"), conversational, about 140–150 words per minute, a beat of silence before each act card.
- **Pronunciation sheet**, applied to the spoken text before synthesis. The display text and captions keep the real spellings.

  | Written | Said as |
  |---|---|
  | llama.cpp | llama dot C P P |
  | libllama | lib llama |
  | GGML | G G M L |
  | KV cache | K V cache |
  | vLLM | V L L M |
  | ZMQ | zero M Q |

- **Score:** one procedural theme, 100 BPM in D major. It builds per act and drops out at "stop". It ducks under the narration.
- **Sound:** each lane has its own motif (switchboard clunk, typewriter keys, pneumatic whoosh, card-drawer slide, lottery rattle, ticker keys), so the ear tracks where the request is.
- **Master:** about −16 LUFS integrated, true peak at or below −1.5 dBTP.

## Formats and captions

- **16:9** (1920×1080) for this site, YouTube and portfolio. Captions are burned in as a lower third, with the current word lit in amber and technical terms in mono.
- **9:16** (1080×1920) for LinkedIn, X, Shorts and Reels. It uses the same scenes with its own camera track, not a crop.
- Each video also ships a separate VTT/SRT.
- Keep site copies under about 30 MB: two-pass or capped H.264 at about 1.9 Mb/s for 16:9.

## How the videos are made

1. **Script** from the tracer data, with each claim tied to function and file:line, then run through the pronunciation sheet.
2. **Narration:** one continuous ElevenLabs take, cut into lines at the silences. Speech-to-text then gives word timings, which drive both the animation beats and the captions.
3. **Image plates** from HiDream-I1 (open, MIT licence), with seeded prompts so any plate can be regenerated. They are inked, cut out and halftoned in code.
4. **Motion:** a seekable GSAP timeline in a single HTML page, with a camera rig and the thread. It is rendered frame by frame in headless Chromium at 30 fps, with motion blur on camera moves. Every animation beat is keyed to a word in the narration, never to a hard-coded second.
5. **Score and sound effects** are synthesized in code from the same timeline's cue list, then mixed and mastered.
6. **Checks before shipping:**
   - Facts match the tracer source.
   - Speech-to-text of the final mix reads back correctly.
   - Keyed words land within 50 ms of their visual hit.
   - Contact sheets show no clipped text.
   - Loudness is on target.
   - The file is under 30 MB.

Render cost: a 1:44 episode is about 3,100 frames and about 30 minutes per format on the current machine. Budget for that, or render one format at a time.

## Release plan

| Format | Where | Call to action |
|---|---|---|
| 16:9 | This site's "short version" section, a YouTube playlist, the portfolio | Open the tracer; next episode |
| 9:16 | LinkedIn, X, YouTube Shorts, Instagram Reels | Open the tracer (link in the post) |
| Trailer | Pinned post, top of the README | Watch Episode 1 |
| GIF loops | One per stage, in the README beside its tracer section | Click through to the tracer |

Cadence: the trailer and Episode 1 together, then one episode a week.

## Privacy rule for anything committed here

No personal details in files, video frames, captions or metadata. That means no account names, emails or usernames. End cards point to "the tracer below" rather than printing a URL that contains an account name.

## Next steps

1. Render the 9:16 cut of Episode 1. The scenes and audio are done; only the render remains.
2. Episode 2, "Warm Start": a second message reuses slot 0's cached prefix. Show the prompt-processing work that is skipped, with real `timings` from a llama-server run.
3. The 20-second trailer.
4. Embed each episode on its tracer page as well as on the start page.
