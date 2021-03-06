'use_strict';
import * as fs from 'fs';
// @ts-ignore
import draco3d from 'draco3d';
import { byteArrayToLong, lerp } from '../Shared/Utilities';
import { Action, IFileHeader, IBufferGeometryCompressedTexture, WorkerDataRequest, WorkerInitializationRequest, WorkerInitializationResponse } from './Interfaces';
import { RingBuffer } from 'ring-buffer-ts';
import { Scene, BufferGeometry, CompressedTexture, BoxBufferGeometry, MeshBasicMaterial, Mesh } from 'three';
import { BasisTextureLoader } from './libs/BasisTextureLoader';
import { ReadStream } from 'fs';
import { MessageType } from './Enums';

const worker = new Worker('./Worker')

// Class draco / basis player
export default class DracosisPlayer {
    // Public Fields
    public frameRate: number = 30;
    public speed: number = 1.0; // Multiplied by framerate for final playback output rate

    // Three objects
    public scene: Scene;
    public mesh: Mesh;
    public material: MeshBasicMaterial;
    public bufferGeometry: BufferGeometry; 
    public compressedTexture: CompressedTexture;

    // Private Fields
    private _startFrame = 0;
    private _endFrame = 0;
    private _numberOfFrames: number = 0;
    private _currentFrame = 0;
    private _loop: boolean = true;
    private _playOnStart: boolean = true;
    private _isinitialized: boolean = false;
    private _onLoaded: any // External callback when volumetric is loaded
    private _ringBuffer: RingBuffer<IBufferGeometryCompressedTexture>;
    private _dataBufferSize: number = 100;
    private _filePath: string;
    private _isPlaying: boolean = false;
    private _fileHeader: IFileHeader;

    private _fileReadStream: ReadStream;
    private _readStreamOffset: number = 0;
    private _decoderModule = draco3d.createDecoderModule({});
    private _encoderModule = draco3d.createEncoderModule({});
    private _basisTextureLoader = new BasisTextureLoader();

    private _nullBufferGeometry = new BufferGeometry();
    private _nullCompressedTexture = new CompressedTexture([new ImageData(0, 0)], 0, 0);

    // Temp variables -- reused in loops, etc (beware of initialized value!)
    private _pos = 0;
    private _frameNumber = 0;
    private _framesUpdated = 0; // TODO: Remove after debug
    private _numberOfBuffersRemoved = 0; // TODO: Remove after debug

    // public getters and settings
    get currentFrame(): number {
        return this._currentFrame;
    }

    get startFrame(): number {
        return this._startFrame;
    }
    set startFrame(value: number){
        this._startFrame = value;
        this._numberOfFrames = this._endFrame - this._startFrame;
        worker.postMessage({ type: MessageType.SetEndFrameRequest, value } as Action)
    }

    get endFrame(): number {
        return this._endFrame;
    }
    set endFrame(value: number){
        this._endFrame = value;
        this._numberOfFrames = this._endFrame - this._startFrame;
        worker.postMessage({ type: MessageType.SetEndFrameRequest, value } as Action)
    }

    get loop(): boolean {
        return this._loop;
    }
    set loop(value: boolean) {
        this._loop = value;
        worker.postMessage({ type: MessageType.SetLoopRequest, value } as Action)
    }

    constructor(
        scene: any,
        filePath: string,
        onLoaded: any,
        playOnStart: boolean = true,
        loop: boolean = true,
        startFrame: number = 0,
        endFrame: number = -1,
        speedMultiplier: number = 1,
        bufferSize: number = 100
    ) {
        this.scene = scene;
        this._filePath = filePath;
        this._onLoaded = onLoaded;
        this._loop = loop;
        this.speed = speedMultiplier;
        this._startFrame = startFrame;
        this._playOnStart = playOnStart;

        // Validate file exists, throw error if it doesn't
        if (!fs.existsSync(filePath)) {
            console.error("File not found at " + filePath);
            return;
        }

        // Open the file
        fs.open(filePath, 'r', (err, fd) => {
            if (err) return console.log(err.message);

            // Read first 8 bytes for header length (long)
            let buffer = Buffer.alloc(8);
            fs.readSync(fd, buffer, 0, 8, 0);
            const fileHeaderLength = byteArrayToLong(buffer);

            // Read the header bytes (skip the header length, first 8 bytes)
            buffer = Buffer.alloc(fileHeaderLength);
            fs.readSync(fd, buffer, 0, fileHeaderLength, 8); // Skip 8 bytes for the header length val

            // Buffer to json, json to object
            this._fileHeader = JSON.parse(buffer.toString('utf8'));
            console.log('Parsed to json: ', this._fileHeader);

            this._readStreamOffset = fileHeaderLength + 8;

            // Get current frame
            this._currentFrame = startFrame;

            // If the end frame was supplied, use it, otherwise determine from length
            if (endFrame > 1) {
                this._endFrame = endFrame;
            } else {
                this._endFrame = this._fileHeader.frameData.length;
            }

            this._numberOfFrames = this._endFrame - this._startFrame;

            // Create Threejs object, right now it starts as a cube
            this.bufferGeometry = new BoxBufferGeometry(1, 1, 1);
            this.material = new MeshBasicMaterial({ color: 0xffff00 });
            this.mesh = new Mesh(this.bufferGeometry, this.material);
            scene.add(this.mesh);

            // init buffers with settings
            this._ringBuffer = new RingBuffer<IBufferGeometryCompressedTexture>(bufferSize);

            // Send init data to worker
            const initializeMessage: WorkerInitializationRequest = {
                startFrame,
                endFrame,
                type: MessageType.InitializationResponse,
                loop,
                filePath,
                fileHeader: this._fileHeader,
                readStreamOffset: this._readStreamOffset,
            }

            worker.postMessage(initializeMessage);

            // Add event handler for manging worker responses
            worker.addEventListener('message', ({ data }) => {
                this.handleMessage(data);
            });
        });
    }

    handleMessage(data: any){
        switch (data.type) {
            case MessageType.InitializationResponse:
                this.handleInitializationResponse(data);
                break;
            case MessageType.DataResponse: {
                this.handleDataResponse(data);
                break;
            }
        }
    }

    handleInitializationResponse(data: WorkerInitializationResponse) {
        if (data.isInitialized){
            this._isinitialized = true;
            this.handleBuffers();
            if(this._playOnStart) this.play();
            console.log("Received initialization response from worker");
        }
        else
            console.error("Initialization failed");
    }

    handleDataResponse(data: IBufferGeometryCompressedTexture[]) {
        // For each object in the array...
        data.forEach((geomTex) => {
            this._frameNumber = geomTex.frameNumber;
            // Find the frame in our circular buffer
            this._pos = this.getPositionInBuffer(this._frameNumber);
            // Set the mesh and texture buffers
            this._ringBuffer.get(this._frameNumber).bufferGeometry = geomTex.bufferGeometry;
            this._ringBuffer.get(this._frameNumber).compressedTexture = geomTex.compressedTexture;
            this._framesUpdated++;
        })
        console.log("Updated mesh and texture data on " + this._framesUpdated + " frames");
    }

    getPositionInBuffer(frameNumber: number): number {
        // Search backwards, which should make the for loop shorter on longer buffer
        for (let i = this._ringBuffer.getPos(); i > 0; i--)
            if (frameNumber = this._ringBuffer.get(i).frameNumber)
                return i;
        return -1;
    }

    handleBuffers() {
        // If not initialized, skip.
        if(!this._isinitialized) return setTimeout(this.handleBuffers, 100);
        // Clear the buffers
        while (true) {
            // Peek the current frame. if it's frame number is below current frame, trash it
            if (this._ringBuffer.getFirst().frameNumber >= this._currentFrame)
                break;

            // if it's equal to or greater than current frame, break the loop
            this._ringBuffer.removeFirst();
            this._numberOfBuffersRemoved++;
        }
        if (this._numberOfBuffersRemoved > 0)
            console.warn("Removed " + this._numberOfBuffersRemoved + " since they were skipped in playback");

        let framesToFetch: number[] = []

        // Fill buffers with new data
        while (!this._ringBuffer.isFull()) {
            // Increment onto the last frame
            const lastFrame = this._ringBuffer.getLast().frameNumber;
            const nextFrame = (lastFrame + 1) % this._numberOfFrames;
            const frameData: IBufferGeometryCompressedTexture = {
                frameNumber: nextFrame,
                bufferGeometry: this._nullBufferGeometry,
                compressedTexture: this._nullCompressedTexture
            }
            framesToFetch.push(nextFrame);
            this._ringBuffer.add(frameData);
        }

        const fetchFramesMessage: WorkerDataRequest = {
            type: MessageType.DataRequest,
            framesToFetch
        }

        if (framesToFetch.length > 0)
            worker.postMessage(fetchFramesMessage);

        // Every 1/4 second, make sure our workers are working
        setTimeout(this.handleBuffers, 100);
    }

    update() {
        console.log("Player update called, current frame is + " + this._currentFrame)

        // If playback is paused, stop updating
        if (!this._isPlaying) return;

        // If we aren't initialized yet, skip logic but come back next frame
        if(!this._isinitialized) return setTimeout(this.update, (1.0 / this.frameRate) * this.speed);

        // Advance to next frame
        this._currentFrame++;

        // Loop logic
        if (this._currentFrame >= this._endFrame) {
            if (this._loop) this._currentFrame = this._startFrame;
            else {
                this._isPlaying = false;
                return;
            }
        }

        // If the frame exists in the ring buffer, use it
        if (this._ringBuffer.getFirst().frameNumber == this._currentFrame) {
            // read buffer into current buffer geometry
            this.bufferGeometry = this._ringBuffer.getFirst().bufferGeometry;

            // read buffer into current texture
            this.compressedTexture = this._ringBuffer.getFirst().compressedTexture;

            // Remove buffer
            this._ringBuffer.removeFirst();
            console.log("Recalled the frame " + this._ringBuffer.getFirst().frameNumber)
        } else {
            // Frame doesn't exist in ring buffer, so throw an error
            console.warn("Frame " + this._ringBuffer.getFirst().frameNumber + " did not exist in ring buffer");
        }

        // Advance current buffer
        setTimeout(this.update, (1.0 / this.frameRate) * this.speed);
    }

    play() {
        this._isPlaying = true;
        this.show();
        this.update();
    }

    pause() {
        this._isPlaying = false;
    }

    reset() {
        this._currentFrame = this._startFrame;
    }

    goToFrame(frame: number, play:boolean) {
        this._currentFrame = frame;
        this.handleBuffers();
        if(play) this.play();
    }

    setSpeed(multiplyScalar: number) {
        this.speed = multiplyScalar;
    }

    show() {
        this.mesh.visible = true;
    }

    hide() {
        this.mesh.visible = false;
        this.pause()
    }

    fadeIn(stepLength: number = .1, fadeTime: number, currentTime: number = 0) {
        if (!this._isPlaying) this.play();
        this.material.opacity = lerp(0, 1, currentTime / fadeTime);
        currentTime = currentTime + stepLength * fadeTime;
        if (currentTime >= fadeTime) {
            this.material.opacity = 1;
            return;
        }

        setTimeout(() => { this.fadeIn(fadeTime, currentTime); }, stepLength * fadeTime);
    }

    fadeOut(stepLength: number = .1, fadeTime: number, currentTime: number = 0) {
        this.material.opacity = lerp(1, 0, currentTime / fadeTime);
        currentTime = currentTime + stepLength * fadeTime;
        if (currentTime >= fadeTime) {
            this.material.opacity = 0;
            this.pause();
            return;
        }

        setTimeout(() => { this.fadeOut(fadeTime, currentTime); }, stepLength * fadeTime);
    }
}
