# Multi-QR Manual Transfer Guide

This guide covers how to use the multi-QR code feature for Manual mode (offline) file transfers.

## When to Use This

Manual mode is useful when:
- You want to transfer files between two devices on the same local network without internet
- You prefer not to use any signaling server
- You want the highest privacy (no server involved at all)

## How It Works

In Manual mode, the sender's offer (connection details + file metadata + encryption key) is split into multiple small URL-based QR codes. The receiver scans any one of them with their phone camera to open the app, then scans the rest in-app.

## Step-by-Step

### Sender

1. Open the app and select your file(s)
2. Under **Advanced Options**, select **Manual** mode
3. Click **Send**
4. A grid of QR codes appears (typically 2-4 codes), each labeled "1 of N", "2 of N", etc.
5. Tell the receiver to scan any one QR code with their phone camera

### Receiver

1. Point your phone camera at any one of the sender's QR codes
2. Your phone shows a link notification — tap it to open the app
3. The app opens and shows your collection progress ("Collected 1 of N")
4. The in-app camera activates automatically — scan the remaining QR codes one by one
5. Once all codes are collected, the app automatically starts the transfer
6. A response QR code appears on your screen — show it to the sender

### Back to Sender

1. When the receiver shows their response QR code, scan it with the in-app scanner (or paste it)
2. The P2P connection establishes and the file transfers directly
3. Both sides show "Transfer Complete" when done

## Tips

- **Order doesn't matter**: You can scan the QR codes in any order
- **Duplicates are fine**: Scanning the same QR code twice won't cause issues
- **Copy/paste fallback**: If cameras aren't available, use the "Copy Data" button on the sender side and paste it on the receiver's `/receive` page under the "Scan Code" → "Paste" tab
- **Single QR**: Very small payloads (under ~400 bytes) produce just one QR code — the flow still works the same way
- **Same network required**: Without internet, both devices must be on the same Wi-Fi or local network. With internet, STUN enables connections across different networks.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Phone camera doesn't show a link | Make sure the QR code is well-lit and in focus. The QR contains a URL that your phone should recognize. |
| App doesn't open from the link | Open the app manually and navigate to the URL shown in the link. The `/r?d=...` path is the chunked receive page. |
| "Camera access denied" in-app | Allow camera permissions in your browser settings and reload the page. |
| Transfer fails after all chunks collected | Both devices must have network connectivity to each other (same Wi-Fi, or both on the internet). |
| Sender shows expired error | The offer has a 1-hour TTL. Generate a new offer by retrying. |
