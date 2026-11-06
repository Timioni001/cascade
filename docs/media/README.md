# Media

| File | What it is |
| --- | --- |
| `cascade-coming-soon-1600x900.png`, `-1080x1080.png` | Announcement images (16:9 and square) |
| `coming-soon.html` | Their source. Open it in a browser with `?w=1600&h=900` and screenshot, or re-render with the script in the repo's history |
| `screens/` | Product tour screenshots used by the README, captured during `pnpm test:e2e` and resized |

`apps/web/public/coins/*.svg` are the monochrome coin logos from [cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) (CC0-1.0, public domain). Only the eight used on the landing page are vendored, and dark mode inverts them; there is no runtime dependency.
