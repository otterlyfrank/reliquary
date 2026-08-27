# Reliquary — for writers who are not “computer people”

You do **not** need to know coding. You need:

1. This folder (download from GitHub or unzip)
2. A normal browser (Chrome is fine)
3. Python (one free install if you don’t have it) — only to open the vault the first time

---

## Put Reliquary in Applications / on the taskbar

After Reliquary is open in the browser:

1. **Chrome or Edge** — click the **install** icon in the address bar, or the menu → **Install Reliquary** / **Install page as app**
2. **Safari (Mac)** — **File → Add to Dock…**
3. Or in the app: **Settings → Install Reliquary**

Then pin it like any other app. You are **not** downloading a special installer from us for this — the browser does it.

---

## Mac (first open)

1. Open **Terminal** (Spotlight → type `Terminal`)
2. Paste this and press Enter (adjust the path if your folder is elsewhere):

```bash
cd ~/Desktop/OtterlyEnterprises/Software/reliquary
./start.sh
```

3. A page should open. If not, go to: **http://127.0.0.1:8780**
4. **Install as app** (see above), then click **Whole folder** and pick the folder where all your drafts live (subfolders are included).

To quit the small server later: click the Terminal window and press **Control+C**.  
On a Mac, `./start.sh` now leaves Reliquary running in the background (same idea as Otterly Leads). The Dock icon only works while that server is up. To keep it up after login:

```bash
~/Desktop/OtterlyEnterprises/Software/reliquary/macos/install-launch-agent.sh
```

---

## Windows (first open)

1. Install Python from [python.org](https://www.python.org/downloads/)  
   **Important:** check the box **“Add Python to PATH”**
2. Unzip Reliquary if needed
3. Double-click **`start.bat`**
4. Open **http://127.0.0.1:8780** if the browser doesn’t open itself
5. **Install as app**, then click **Whole folder** and pick your drafts folder

To quit: close the black window.

---

## What happens to your writing?

- Stays **only on your computer** unless you turn on cloud AI
- Reliquary does **not** put drafts on the internet by default
- Optional AI is **off** until you pick a provider in Settings
- **Ollama** = still local. **xAI Grok** = drafts go to xAI (no training on API traffic by default; you have to tick a privacy box first). Prefer `Reliquary/.env` for the key.

---

## The simple loop

1. **Start here** → open drafts (whole folder is fine)  
2. **My pieces** → cards are *fragments* (dialogue ripped out, idea-dumps split), not whole files  
3. Already imported as one blob? **Sources → Re-split all sources…**  
4. **Work on later** → a shelf for “this could become something”  
5. Export any piece as Markdown when you’re ready to write again elsewhere  

That’s it. You’re not “installing a stack.” You’re opening a vault.

---

## Optional: smarter cuts (AI)

You do not need this. The vault already rips dialogue and splits idea-dumps offline.

- **Ollama (private):** Settings → Optional AI → Ollama, and follow the numbered steps (install Ollama, `ollama pull llama3.1`).
- **xAI Grok API:** Settings → Optional AI → xAI Grok API, and follow the numbered steps (get a key at [console.x.ai](https://console.x.ai), copy `.env.example` to `.env`, restart, Test).
