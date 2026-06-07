# Bundled fonts

These fonts are committed so campaign copy renders identically on every
reviewer's machine — macOS, Windows, Linux — with no system fonts assumed.
They are registered at startup by `packages/CreativeGeneration/src/infrastructure/fonts.ts`.

| Family | Files | Role | Copyright | License |
| --- | --- | --- | --- | --- |
| **Inter** | `Inter-Regular.ttf`, `Inter-Bold.ttf` | Sans — default copy font | © The Inter Project Authors | [SIL OFL 1.1](https://openfontlicense.org) |
| **Lora** | `Lora-Regular.ttf`, `Lora-Bold.ttf` | Serif — optional copy font | © Cyreal | [SIL OFL 1.1](https://openfontlicense.org) |

Select the family per run with the `MESSAGE_FONT` env var (e.g. `MESSAGE_FONT=Lora`);
it defaults to `Inter`. The SIL Open Font License permits bundling and
redistribution provided this notice travels with the fonts.
