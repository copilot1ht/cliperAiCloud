# YouTube Heatmap Evidence

Cliper can use YouTube Most Replayed markers as optional, local evidence for
highlight discovery. This source never replaces transcript, story, audio,
visual, quality, or reviewer evidence.

## Pipeline

```text
YouTube metadata / watch page
  -> normalize Most Replayed markers
  -> dynamic local-maximum selection
  -> filter to the user's selected timeline range
  -> bind each peak to a complete story/transcript context
  -> candidate fusion and deduplication
  -> local score with a maximum five-point corroboration bonus
  -> AI editorial review
  -> diversity and anti-overlap selection
```

The engine does not apply fixed padding around a peak. For example, a peak at
`26:42` inside a story spanning `26:10-27:08` produces the story-bounded
candidate `26:10-27:08`, subject to the existing duration and sentence-boundary
validator.

## Safety Rules

- YouTube sources only; local files continue without heatmap evidence.
- Missing or changed YouTube heatmap data never fails analysis.
- Selected-range analysis never consumes evidence outside the selected range.
- Heatmap does not bypass story, payoff, filler, or evidence gates.
- A weak or dangling transcript receives no heatmap score bonus.
- There is no hardcoded ten-clip limit. Final output remains limited by
  timeline capacity, quality, diversity, and anti-overlap.
- Raw marker data is cached in `youtube-heatmap.json` beside the source cache.
- No external crop, subtitle, or rendering code is used.

## Attribution

The architecture was informed by the MIT-licensed
[`naufaljct48/youtube-heatmap-clipper`](https://github.com/naufaljct48/youtube-heatmap-clipper)
project. Cliper implements its own current-format parser, story binding,
selected-range filtering, score limits, cache, and fallback behavior. The
reference project's center/split crop implementation is intentionally not part
of Cliper's Camera Director.
