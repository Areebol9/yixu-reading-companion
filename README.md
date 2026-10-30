# Yixu Reading Companion · 宜序伴读

[English](README.md) · [简体中文](README.zh-CN.md)

Yixu is a desktop AI companion for long books. Read at your own pace, talk in the sidebar, and invite a reply to a particular passage. Background processing builds reusable book knowledge while each companion keeps its own conversations and private memories.

![Yixu icon](desktop/assets/app-icon-32.png)

## Download and start

Download the **Windows x64 portable ZIP** from [Releases](https://github.com/Areebol9/yixu-reading-companion/releases). Extract the entire folder and double-click **Start Yixu Reading Companion.cmd**. Windows 10 or 11 x64 is required. Electron, Node.js, and production dependencies are included; no development tools are needed.

The app starts with an empty library. It includes no books, personal conversations, API keys, or reading archives.

1. In **Settings**, choose **English** or **简体中文**. The choice is saved. A fresh English archive uses **Yu Xiaoyu**, faithfully translated from the Chinese persona and examples. Changing language in an existing archive preserves its chosen companion.
2. Import a TXT file you have permission to use, then select your reading position.
3. Configure a background model in **Model settings**. On the companion page, independently bind a model to your companion. Enter your service URL, model identifier, and API key. Use an OpenAI-compatible service with streaming and tool calls. Provider charges apply; the app does not supply inference credits.
4. Start reading together, send a sidebar message, or leave a paragraph comment and invite a reply. The reply remains attached to your comment when you move elsewhere.
5. Pause when needed. Already-sent requests are received and saved. Reopening keeps your records and does not automatically resume paid model work.

The book stays in the main reading area. Paragraph comment counts sit after the text. Chat history loads older messages as you scroll up. The companion's name and avatar identify its contributions.

## Nebius and NVIDIA models

The same settings support Nebius Token Factory:

- Base URL: `https://api.tokenfactory.nebius.com/v1`
- Model: choose a NVIDIA model available in your account. HTTP streaming and tool-result continuation have been checked with `nvidia/Nemotron-3_5-Lightning`.
- API key: supply your own Token Factory key. Do not include it in a public repository or distributable.

This check covers transport and tool continuation, not complete reading-session quality or speed for every model. Set supported context and output limits using [Token Factory documentation](https://docs.tokenfactory.nebius.com/) and the current model catalog.

## Data and privacy

Books, conversations, reading permissions, saved responses, and usage records are stored locally. Material needed for an authorized request is sent to the selected provider. The app does not post comments on external reading platforms.

The default data root is `%LOCALAPPDATA%\YixuReading\Desktop`; the app remembers its selected location. **File → Open data folder** shows the actual folder. Set `YIXU_DATA_DIR` before startup to select a separate data root. Keep your data folder when replacing program files.

**Book details** lets you choose and migrate book project folders for agents. Imported source text stays separately in the app's library. Book analysis is shared within the book project; private companion memories keep their owner. Use the normal backup/export and import functions to transfer reading archives. Unconfirmed requests keep their original records and recovery actions rather than being blindly resent.

## Window and background operation

- Launching again opens the existing instance.
- The notification-area icon opens the main window and offers **Save and quit**.
- Minimizing stops new manual reading observations; accepted background work continues.
- Closing during active work offers background processing or waiting for current replies to be saved.
- Agent/headless mode uses the same archive. It can open the same window later without taking mouse or keyboard focus during background work.

## Build and package

Requires Node.js 24 or newer. Windows is required for the desktop package.

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run build
npm run desktop
pwsh -File scripts/package-client.ps1
```

The complete ZIP and SHA-256 checksum are written to `artifacts/`. The packager uses locked dependencies and the official Node.js distribution. It includes the sources listed in `client-core-manifest.json`, the desktop shell, compiled interface, licenses, and production dependencies. Development records and user data are excluded.

## Agent interface

**Agent.cmd** returns JSON and controls the same authenticated local service as the window:

```powershell
.\Agent.cmd start --headless
.\Agent.cmd status
.\Agent.cmd import .\book.txt
.\Agent.cmd command sendMessage --json '["What do you make of this passage?",false]'
.\Agent.cmd pause
.\Agent.cmd export --file .\reading-backup.json
.\Agent.cmd open
.\Agent.cmd hide
.\Agent.cmd quit
```

From source, use `node desktop/agent.cjs <command>`. `status` is lightweight; `snapshot` explicitly fetches the larger interface snapshot. Accepted/running commands return identifiers for checking the same operation:

```powershell
.\Agent.cmd operation "<commandId>" --archive-id "<archiveId>" --epoch "<epoch>"
```

Use `extend-source <file> --book-id <id>` to append a matching later edition while preserving existing text and anchors. Developer automatic reading uses `auto-read --json '<settings>'`; `AutoReadingSettings` in `src/workbench/contract.ts` defines the explicit range, speed, and cumulative token limit. It can incur model usage. Hidden execution does not establish that a human saw a reply on screen.

## Current limitations

This is a development release. Long conversation context and large background outputs can cause noticeable delays. Work at the final reading position may remain queued after a pause and continue when resumed. Background completion and a natural, timely companion experience remain separate goals. Different companions can be configured, but simultaneous multi-companion reading is not implemented.

## Contributing and license

Report reproducible issues using sanitized diagnostics; never include API keys, copyrighted book text, or personal archives. UI changes should cover both languages and preserve the reading area. Storage changes should preserve existing records and recovery behavior.

Source is licensed under **GPL-3.0-only**. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
