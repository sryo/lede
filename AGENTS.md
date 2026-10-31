# Working on Lede

Read these parts before changing anything, not the whole files:

- [docs/how-its-built.md](docs/how-its-built.md): how Lede works inside. Read "Before you change anything" and "Change recipes", then the section your change touches.
- [GOALS.md](GOALS.md): read "Goals, in priority order" and "When a change costs more" before a change that costs anything.
- [docs/how-it-works.md](docs/how-it-works.md): what owners see and are told. Read it only for a change owners will see or be told about.
- fium's `~/Documents/fium/RULES.md`, rules K1–K5: how every change is priced. `npm run bench:compare` runs its `compare`.

- [DESIGN.md](DESIGN.md): the design tokens on `public/index.html`'s `:root`, in Google's DESIGN.md format. Change a token in both; `bench/checks` fails when they differ.

A change that makes either doc wrong updates it in the same commit.

## Test

```bash
npm test
```
