# TheDigitalRoom

### Developer's Manifesto
*The web was once a place of raw, unpolished energy. It wasn't about "user flows" or "conversion funnels"; it was about carving out a digital corner that felt like home. "TheDigitalRoom" is a tribute to those late nights on MySpace, the crackle of a fresh SoundCloud upload, and the thrill of discovery in a chatroom full of strangers connected by a single beat.*

*We reject the sterile, rounded-corner minimalism of today. We embrace the marquee. We embrace the blink. We welcome you to the sonic collective.*

---

## Technical Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v14 or higher recommended)
- `npm` (comes with Node)

### Installation
1.  Navigate to the project directory:
    ```bash
    cd TheDigitalRoom
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start the server:
    ```bash
    node server.js
    ```
4.  Open your browser and go to `http://localhost:3000`.

### Features
- **DJ Mode:** The first person to click "TAKE CONTROL" becomes the room's DJ. Their playback state (play/pause, current track, and time) is synchronized to all other users in real-time.
- **Dynamic Chat:** A real-time chat powered by Socket.io.
- **Web 2.0 Aesthetic:** Custom CSS designed to mimic the 2005-2008 era of localized style overrides and high-contrast visuals.
- **SoundCloud Integration:** Powered by the SC Widget API.

### Note on SoundCloud API
This application uses the **SoundCloud Widget API**. Unlike the standard SoundCloud JS SDK, the Widget API does **not** require a `client_id` for basic controls and playback of public tracks. 
*   **DJ Command:** If you are the DJ, you can change the track by typing `/play [SOUNDCLOUD_URL]` in the chat box.
*   **Restrictions:** Some tracks may have "Embed disabled" by their creators, which will prevent them from playing in the room.

### Code Integrity
The synchronization logic uses a "Sync Pulse" every second from the DJ client to ensure all members are within ~2 seconds of the DJ's playback position, accounting for network latency and browser buffering.
