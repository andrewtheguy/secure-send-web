export type WebRTCSignal =
    | { type: 'offer'; sdp: string }
    | { type: 'answer'; sdp: string }
    | { type: 'candidate'; candidate?: RTCIceCandidateInit | null };

type WebRTCData = string | ArrayBuffer | ArrayBufferView | Blob

export class WebRTCConnection {
    private pc: RTCPeerConnection;
    private dataChannel: RTCDataChannel | null = null;
    private onSignal: (signal: WebRTCSignal) => void;
    private onDataChannelOpen: () => void;
    private onDataChannelMessage: (data: string | ArrayBuffer) => void;
    private onConnectionStateChange?: (state: RTCPeerConnectionState) => void;

    private remoteDescriptionSet = false;
    private candidateQueue: RTCIceCandidate[] = [];

    constructor(
        config: RTCConfiguration,
        onSignal: (signal: WebRTCSignal) => void,
        onDataChannelOpen: () => void,
        onDataChannelMessage: (data: string | ArrayBuffer) => void,
        onConnectionStateChange?: (state: RTCPeerConnectionState) => void
    ) {
        this.pc = new RTCPeerConnection(config);
        this.onSignal = onSignal;
        this.onDataChannelOpen = onDataChannelOpen;
        this.onDataChannelMessage = onDataChannelMessage;
        this.onConnectionStateChange = onConnectionStateChange;

        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('Generated ICE candidate:', event.candidate.candidate);
                this.onSignal({ type: 'candidate', candidate: event.candidate });
            }
        };

        this.pc.onconnectionstatechange = () => {
            console.log('WebRTC connection state:', this.pc.connectionState);
            if (this.pc.connectionState === 'failed') {
                console.error('WebRTC Connection failed');
            }
            if (this.onConnectionStateChange) {
                this.onConnectionStateChange(this.pc.connectionState);
            }
        };

        this.pc.ondatachannel = (event) => {
            console.log('Received DataChannel from remote');
            this.setupDataChannel(event.channel);
        };

        this.pc.oniceconnectionstatechange = () => {
            console.log('ICE Connection State:', this.pc.iceConnectionState);
        };
    }

    public createDataChannel(label: string) {
        console.log('Creating DataChannel:', label);
        const channel = this.pc.createDataChannel(label);
        this.setupDataChannel(channel);
    }

    private setupDataChannel(channel: RTCDataChannel) {
        this.dataChannel = channel;
        this.dataChannel.onopen = () => {
            console.log('Data channel open state:', this.dataChannel?.readyState);
            this.onDataChannelOpen();
        };
        this.dataChannel.onmessage = (event) => {
            this.onDataChannelMessage(event.data);
        };
        this.dataChannel.onerror = (err) => {
            console.error('DataChannel error:', err);
        };
    }

    public async createOffer() {
        console.log('Creating Offer...');
        const offer = await this.pc.createOffer();
        console.log('Offer created, setting local description...');
        await this.pc.setLocalDescription(offer);
        console.log('Local description set. Sending offer signal.');
        if (!offer.sdp) {
            throw new Error('Failed to create offer: SDP is missing');
        }
        this.onSignal({ type: 'offer', sdp: offer.sdp });
    }

    public async handleSignal(signal: WebRTCSignal) {
        console.log('Handling signal:', signal.type);
        try {
            if (signal.type === 'offer') {
                if (!signal.sdp) {
                    throw new Error('Invalid offer signal: SDP is missing');
                }
                console.log('Setting remote offer...');
                await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp }));
                this.remoteDescriptionSet = true;
                await this.processQueue();

                console.log('Creating answer...');
                const answer = await this.pc.createAnswer();
                await this.pc.setLocalDescription(answer);
                if (!answer.sdp) {
                    throw new Error('Failed to create answer: SDP is missing');
                }
                this.onSignal({ type: 'answer', sdp: answer.sdp });
            } else if (signal.type === 'answer') {
                if (!signal.sdp) {
                    throw new Error('Invalid answer signal: SDP is missing');
                }
                console.log('Setting remote answer...');
                await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
                this.remoteDescriptionSet = true;
                await this.processQueue();
            } else if (signal.type === 'candidate') {
                if (signal.candidate) {
                    let candidate: RTCIceCandidate;
                    try {
                        candidate = new RTCIceCandidate(signal.candidate);
                    } catch (e) {
                        console.warn('Ignoring invalid ICE candidate payload:', e);
                        return;
                    }

                    if (this.remoteDescriptionSet && this.pc.remoteDescription) {
                        console.log('Adding ICE candidate immediately');
                        await this.addIceCandidateSafely(candidate, 'immediate');
                    } else {
                        console.log('Buffering ICE candidate (remote description not set)');
                        this.candidateQueue.push(candidate);
                    }
                }
            }
        } catch (err) {
            console.error('Error handling signal:', err);
            throw err;
        }
    }

    public getPeerConnection(): RTCPeerConnection {
        return this.pc;
    }

    public getDataChannel(): RTCDataChannel | null {
        return this.dataChannel;
    }

    /**
     * Wait for ICE gathering to complete with a bounded timeout.
     * Uses event listeners + post-subscribe checks to avoid missing the completion event.
     * If the peer connection fails while waiting, rejects immediately.
     * Returns true when ICE gathering reaches "complete", false on timeout.
     */
    public async waitForIceGatheringComplete(timeoutMs: number = 5000): Promise<boolean> {
        if (this.pc.iceGatheringState === 'complete') {
            return true;
        }

        return await new Promise<boolean>((resolve, reject) => {
            let settled = false;
            const startedAt = Date.now();

            const cleanup = () => {
                this.pc.removeEventListener('icegatheringstatechange', onIceGatheringStateChange);
                this.pc.removeEventListener('connectionstatechange', onConnectionStateChange);
                clearTimeout(timeoutId);
                clearInterval(pollId);
            };

            const settleResolve = (completed: boolean) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(completed);
            };

            const settleReject = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };

            const checkState = () => {
                if (this.pc.iceGatheringState === 'complete') {
                    settleResolve(true);
                    return;
                }
                if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
                    settleReject(new Error('Connection failed while gathering network info'));
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    settleResolve(false);
                }
            };

            const onIceGatheringStateChange = () => {
                checkState();
            };

            const onConnectionStateChange = () => {
                checkState();
            };

            const timeoutId = setTimeout(() => {
                settleResolve(false);
            }, timeoutMs);
            const pollId = setInterval(checkState, 250);

            this.pc.addEventListener('icegatheringstatechange', onIceGatheringStateChange);
            this.pc.addEventListener('connectionstatechange', onConnectionStateChange);

            // Check after subscribing to avoid missing a race where state flips before handler attach.
            checkState();
        });
    }

    private async processQueue() {
        console.log(`Processing ${this.candidateQueue.length} buffered candidates`);
        while (this.candidateQueue.length > 0) {
            const c = this.candidateQueue.shift();
            if (c) {
                await this.addIceCandidateSafely(c, 'buffered');
            }
        }
    }

    private async addIceCandidateSafely(candidate: RTCIceCandidate, source: 'immediate' | 'buffered') {
        try {
            await this.pc.addIceCandidate(candidate);
        } catch (e) {
            // Ignore individual ICE candidate failures so remaining candidates can still establish connectivity.
            console.warn(`Ignoring ${source} ICE candidate error:`, e);
        }
    }

    public send(data: WebRTCData) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('Data channel not open');
        }

        this.sendData(data);
    }

    /**
     * Send data with backpressure support.
     * Waits for buffer to drain if it exceeds the threshold.
     */
    public async sendWithBackpressure(
        data: WebRTCData,
        bufferThreshold: number = 1024 * 1024 // 1MB default threshold
    ): Promise<void> {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('Data channel not open');
        }

        // Wait for buffer to drain if it's too full
        while (this.dataChannel.bufferedAmount > bufferThreshold) {
            await new Promise<void>((resolve) => {
                // Use bufferedamountlow event if supported, otherwise poll
                const checkBuffer = () => {
                    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                        resolve();
                        return;
                    }
                    if (this.dataChannel.bufferedAmount <= bufferThreshold) {
                        resolve();
                    } else {
                        setTimeout(checkBuffer, 10);
                    }
                };
                setTimeout(checkBuffer, 10);
            });
        }

        this.sendData(data);
    }

    private sendData(data: WebRTCData) {
        if (!this.dataChannel) {
            throw new Error('Data channel not open');
        }

        if (typeof data === 'string') {
            this.dataChannel.send(data);
        } else if (data instanceof Blob) {
            this.dataChannel.send(data);
        } else if (data instanceof ArrayBuffer) {
            this.dataChannel.send(data);
        } else if (ArrayBuffer.isView(data)) {
            const copyBuffer = new ArrayBuffer(data.byteLength);
            new Uint8Array(copyBuffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            this.dataChannel.send(new Uint8Array(copyBuffer));
        } else {
            throw new Error('Unsupported data type for data channel send');
        }
    }

    public close() {
        if (this.dataChannel) this.dataChannel.close();
        this.pc.close();
    }
}
