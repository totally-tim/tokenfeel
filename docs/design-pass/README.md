# Design and motion pass — before/after evidence

Side-by-side captures backing the design-motion-pass branch. Both halves of every
composite were taken against the same dev server at 1440x900 with the Race lanes
pinned via share URL, so the two sides differ only by the restyle:

```
#race?a=m4-max-40c-48gb__qwen3.5-9b__4bit__omlx-api-0.2.20rc1-macos-26.3.1-ba0076cc8b
     &b=m5-max-40c-128gb__qwen3.5-9b__4bit__omlx-api-0.3.0-macos-26.3.2-1a3d644e5a
     &s=repo-wide-refactor&speed=1
```

| File | What it shows |
| --- | --- |
| `race.jpg` | Race at rest — aligned centre columns, trust badges, readable provenance |
| `race-running.jpg` | Race mid-playback — phase hierarchy, subordinate projected gap |
| `playground.jpg` | Playground — idle rows sized to content instead of stretched |
| `method.jpg` | Data & method — no orphaned fifth card, no dead space |
| `landing.jpg` | Landing — hero descenders no longer clipped |
| `contribute.jpg` | Contribute — hero aligned to the grid, prompt wraps |
| `configs.jpg` | Configs — trust badges in the table |
| `m-race.jpg` | Race at 390px |
| `trust-four-states.jpg` | The four trust states in colour and greyscale, with contrast ratios |

`flagged` and `illustrative` are composed in the proof image rather than captured
from the app: the catalog contains 791 `community` and 5 `verified` rows and zero
of the other two, and inventing rows in `data/` to make a screenshot look good
would violate the provenance rules. The proof uses the same lucide 0.468.0 icon
paths the component imports and the app's own live stylesheet.
