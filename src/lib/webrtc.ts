export type WebRTCSignal =
    | { type: 'offer'; sdp: string | null | undefined }
    | { type: 'answer'; sdp: string | null | undefined }
    | { type: 'candidate'; candidate?: RTCIceCandidateInit | null };

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
        this.onSignal({ type: 'offer', sdp: offer.sdp });
    }

    public async handleSignal(signal: WebRTCSignal) {
        console.log('Handling signal:', signal.type);
        try {
            if (signal.type === 'offer') {
                console.log('Setting remote offer...');
                await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp ?? undefined }));
                this.remoteDescriptionSet = true;
                await this.processQueue();

                console.log('Creating answer...');
                const answer = await this.pc.createAnswer();
                await this.pc.setLocalDescription(answer);
                this.onSignal({ type: 'answer', sdp: answer.sdp });
            } else if (signal.type === 'answer') {
                console.log('Setting remote answer...');
                await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp ?? undefined }));
                this.remoteDescriptionSet = true;
                await this.processQueue();
            } else if (signal.type === 'candidate') {
                if (signal.candidate) {
                    const candidate = new RTCIceCandidate(signal.candidate);
                    if (this.remoteDescriptionSet && this.pc.remoteDescription) {
                        console.log('Adding ICE candidate immediately');
                        await this.pc.addIceCandidate(candidate);
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

    private async processQueue() {
        console.log(`Processing ${this.candidateQueue.length} buffered candidates`);
        while (this.candidateQueue.length > 0) {
            const c = this.candidateQueue.shift();
            if (c) {
                try {
                    await this.pc.addIceCandidate(c);
                } catch (e) {
                    console.error('Error adding buffered candidate:', e);
                }
            }
        }
    }

    public send(data: ArrayBuffer | ArrayBufferView | string) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(data);
        } else {
            throw new Error('Data channel not open');
        }
    }

    /**
     * Send data with backpressure support.
     * Waits for buffer to drain if it exceeds the threshold.
     */
    public async sendWithBackpressure(
        data: ArrayBuffer | ArrayBufferView | string,
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

        this.dataChannel.send(data);
    }

    public close() {
        if (this.dataChannel) this.dataChannel.close();
        this.pc.close();
    }
}
