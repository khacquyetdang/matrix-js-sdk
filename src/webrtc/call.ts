// @ts-nocheck
/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 New Vector Ltd
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * This is an internal module. See {@link createNewMatrixCall} for the public API.
 * @module webrtc/call
 */

import {logger} from '../logger';
import {EventEmitter} from 'events';
import * as utils from '../utils';
import MatrixEvent from '../models/event';
import {EventType} from '../@types/event';
import {
  mediaDevices,
  MediaStream,
  RTCPeerConnection,
  //ConfigurationParamWithUrls,
  //ConfigurationParamWithUrl,
  //EventOnConnectionStateChange,
  MediaStreamConstraints,
  //EventOnAddStream,
  MediaStreamTrack,
  RTCIceCandidate,
  EventOnCandidate,
} from 'react-native-webrtc';
// events: hangup, error(err), replaced(call), state(state, oldState)

/**
 * Fires whenever an error occurs when call.js encounters an issue with setting up the call.
 * <p>
 * The error given will have a code equal to either `MatrixCall.ERR_LOCAL_OFFER_FAILED` or
 * `MatrixCall.ERR_NO_USER_MEDIA`. `ERR_LOCAL_OFFER_FAILED` is emitted when the local client
 * fails to create an offer. `ERR_NO_USER_MEDIA` is emitted when the user has denied access
 * to their audio/video hardware.
 *
 * @event module:webrtc/call~MatrixCall#"error"
 * @param {Error} err The error raised by MatrixCall.
 * @example
 * matrixCall.on("error", function(err){
 *   logger.error(err.code, err);
 * });
 */

interface CallOpts {
  roomId?: string;
  client?: any; // Fix when client is TSified
  forceTURN?: boolean;
  turnServers?: Array<TurnServer>;
}

interface TurnServer {
  urls: Array<string>;
  username?: string;
  password?: string;
  ttl?: number;
}

export enum CallState {
  Fledgling = 'fledgling',
  InviteSent = 'invite_sent',
  WaitLocalMedia = 'wait_local_media',
  CreateOffer = 'create_offer',
  CreateAnswer = 'create_answer',
  Connecting = 'connecting',
  Connected = 'connected',
  Ringing = 'ringing',
  Ended = 'ended',
}

export enum CallType {
  Voice = 'voice',
  Video = 'video',
}

export enum CallDirection {
  Inbound = 'inbound',
  Outbound = 'outbound',
}

export enum CallParty {
  Local = 'local',
  Remote = 'remote',
}

export enum CallEvent {
  Hangup = 'hangup',
  State = 'state',
  Error = 'error',
  Replaced = 'replaced',

  // The value of isLocalOnHold() has changed
  HoldUnhold = 'hold_unhold',
}

enum MediaQueueId {
  RemoteVideo = 'remote_video',
  RemoteAudio = 'remote_audio',
  LocalVideo = 'local_video',
}

export enum CallErrorCode {
  /** The user chose to end the call */
  UserHangup = 'user_hangup',

  /** An error code when the local client failed to create an offer. */
  LocalOfferFailed = 'local_offer_failed',
  /**
   * An error code when there is no local mic/camera to use. This may be because
   * the hardware isn't plugged in, or the user has explicitly denied access.
   */
  NoUserMedia = 'no_user_media',

  /**
   * Error code used when a call event failed to send
   * because unknown devices were present in the room
   */
  UnknownDevices = 'unknown_devices',

  /**
   * Error code usewd when we fail to send the invite
   * for some reason other than there being unknown devices
   */
  SendInvite = 'send_invite',

  /**
   * An answer could not be created
   */
  CreateAnswer = 'create_answer',

  /**
   * Error code usewd when we fail to send the answer
   * for some reason other than there being unknown devices
   */
  SendAnswer = 'send_answer',

  /**
   * The session description from the other side could not be set
   */
  SetRemoteDescription = 'set_remote_description',

  /**
   * The session description from this side could not be set
   */
  SetLocalDescription = 'set_local_description',

  /**
   * A different device answered the call
   */
  AnsweredElsewhere = 'answered_elsewhere',

  /**
   * No media connection could be established to the other party
   */
  IceFailed = 'ice_failed',

  /**
   * The invite timed out whilst waiting for an answer
   */
  InviteTimeout = 'invite_timeout',

  /**
   * The call was replaced by another call
   */
  Replaced = 'replaced',

  /**
   * Signalling for the call could not be sent (other than the initial invite)
   */
  SignallingFailed = 'signalling_timeout',
}

/**
 * The version field that we set in m.call.* events
 * Once we are able to speak v1 VoIP sufficiently, this
 * bumped to 1. While we partially speak v1 VoIP, it remains
 * as 0.
 */
const VOIP_PROTO_VERSION = 0;

/** The fallback ICE server to use for STUN or TURN protocols. */
const FALLBACK_ICE_SERVER = 'stun:turn.matrix.org';

/** The length of time a call can be ringing for. */
const CALL_TIMEOUT_MS = 60000;

class CallError extends Error {
  code: string;

  constructor(code: CallErrorCode, msg: string, err: Error) {
    // Stil ldon't think there's any way to have proper nested errors
    super(msg + ': ' + err);

    this.code = code;
  }
}

/**
 * Construct a new Matrix Call.
 * @constructor
 * @param {Object} opts Config options.
 * @param {string} opts.roomId The room ID for this call.
 * @param {Object} opts.webRtc The WebRTC globals from the browser.
 * @param {boolean} opts.forceTURN whether relay through TURN should be forced.
 * @param {Object} opts.URL The URL global.
 * @param {Array<Object>} opts.turnServers Optional. A list of TURN servers.
 * @param {MatrixClient} opts.client The Matrix Client instance to send events to.
 */
export class MatrixCall extends EventEmitter {
  roomId?: string;
  type: CallType | null;
  callId: string;
  state: CallState;
  hangupParty: CallParty | null = null;
  hangupReason: string = '';
  direction: CallDirection | null = null;
  ourPartyId: string;

  private client: any; // Fix when client is TSified
  private forceTURN: boolean | undefined;
  private turnServers: Array<TurnServer>;
  private candidateSendQueue: Array<RTCIceCandidate>;
  private candidateSendTries: number;
  private mediaPromises: {[queueId: string]: Promise<void>};
  private sentEndOfCandidates: boolean;
  private peerConn: RTCPeerConnection | null = null;
  private screenSharingStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private localAVStream: MediaStream | null = null;
  private inviteOrAnswerSent: boolean;
  private waitForLocalAVStream: boolean = false;
  // XXX: This is either the invite or answer from remote...
  private msg: any;
  // XXX: I don't know why this is called 'config'.
  private config: MediaStreamConstraints | undefined;
  private successor: MatrixCall | undefined;
  private opponentVersion: number | undefined;
  // The party ID of the other side: undefined if we haven't chosen a partner
  // yet, null if we have but they didn't send a party ID.
  private opponentPartyId: string | undefined;
  private inviteTimeout: NodeJS.Timeout | null = null; // in the browser it's 'number'

  // The logic of when & if a call is on hold is nontrivial and explained in is*OnHold
  // This flag represents whether we want the other party to be on hold
  private remoteOnHold;
  private micMuted;
  private vidMuted;

  // Perfect negotiation state: https://www.w3.org/TR/webrtc/#perfect-negotiation-example
  private makingOffer: boolean;
  private ignoreOffer: boolean = false;

  constructor(opts: CallOpts) {
    super();
    this.roomId = opts.roomId;
    this.client = opts.client;
    this.type = null;
    this.forceTURN = opts.forceTURN;
    this.ourPartyId = this.client.deviceId;
    // Array of Objects with urls, username, credential keys
    this.turnServers = opts.turnServers || [];
    if (
      this.turnServers.length === 0 &&
      this.client.isFallbackICEServerAllowed()
    ) {
      this.turnServers.push({
        urls: [FALLBACK_ICE_SERVER],
      });
    }

    this.callId = 'c' + new Date().getTime() + Math.random();
    this.state = CallState.Fledgling;

    // A queue for candidates waiting to go out.
    // We try to amalgamate candidates into a single candidate message where
    // possible
    this.candidateSendQueue = [];
    this.candidateSendTries = 0;

    // Lookup from opaque queue ID to a promise for media element operations that
    // need to be serialised into a given queue.  Store this per-MatrixCall on the
    // assumption that multiple matrix calls will never compete for control of the
    // same DOM elements.
    this.mediaPromises = Object.create(null);

    this.sentEndOfCandidates = false;
    this.inviteOrAnswerSent = false;
    this.makingOffer = false;

    this.remoteOnHold = false;
    this.micMuted = false;
    this.vidMuted = false;
  }

  /**
   * Place a voice call to this room.
   * @throws If you have not specified a listener for 'error' events.
   */
  placeVoiceCall() {
    logger.debug('MyMatrixplaceVoiceCall');
    this.checkForErrorListener();
    this.placeCallWithConstraints(getUserMediaVideoContraints(CallType.Voice));
    this.type = CallType.Voice;
  }

  /**
   * Place a screen-sharing call to this room. This includes audio.
   * <b>This method is EXPERIMENTAL and subject to change without warning. It
   * only works in Google Chrome and Firefox >= 44.</b>
   * @param {Element} remoteVideoElement a <code>&lt;video&gt;</code> DOM element
   * to render video to.
   * @param {Element} localVideoElement a <code>&lt;video&gt;</code> DOM element
   * to render the local camera preview.
   * @throws If you have not specified a listener for 'error' events.
   */
  /*
  async placeScreenSharingCall(
    remoteVideoElement: HTMLVideoElement,
    localVideoElement: HTMLVideoElement,
  ) {
    logger.debug('MyMatrixplaceScreenSharingCall');
    this.checkForErrorListener();
    this.localVideoElement = localVideoElement;
    this.remoteVideoElement = remoteVideoElement;
    try {
      this.screenSharingStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
      });
      logger.debug('MyMatrixGot screen stream, requesting audio stream...');
      const audioConstraints = getUserMediaVideoContraints(CallType.Voice);
      this.placeCallWithConstraints(audioConstraints);
    } catch (err) {
      this.emit(
        CallEvent.Error,
        new CallError(
          CallErrorCode.NoUserMedia,
          'Failed to get screen-sharing stream: ',
          err,
        ),
      );
    }

    this.type = CallType.Video;
  }*/

  private queueMediaOperation(queueId: MediaQueueId, operation: () => any) {
    if (this.mediaPromises[queueId] !== undefined) {
      this.mediaPromises[queueId] = this.mediaPromises[queueId].then(
        operation,
        operation,
      );
    } else {
      this.mediaPromises[queueId] = Promise.resolve(operation());
    }
  }

  /**
   * Configure this call from an invite event. Used by MatrixClient.
   * @param {MatrixEvent} event The m.call.invite event
   */
  async initWithInvite(event: MatrixEvent) {
    this.msg = event.getContent();
    this.peerConn = this.createPeerConnection();
    try {
      await this.peerConn?.setRemoteDescription(this.msg.offer);
    } catch (e) {
      logger.debug('MyMatrixFailed to set remote description', e);
      this.terminate(
        CallParty.Local,
        CallErrorCode.SetRemoteDescription,
        false,
      );
      return;
    }

    // According to previous comments in this file, firefox at some point did not
    // add streams until media started ariving on them. Testing latest firefox
    // (81 at time of writing), this is no longer a problem, so let's do it the correct way.

    //if (!this.remoteStream || this.remoteStream.getTracks().length === 0) {
    //
    if (
      !this.peerConn.getRemoteStreams() ||
      this.peerConn.getRemoteStreams().length === 0
    ) {
      logger.error(
        'No remote stream or no tracks after setting remote description!',
      );
      this.terminate(
        CallParty.Local,
        CallErrorCode.SetRemoteDescription,
        false,
      );
      return;
    }
    this.remoteStream = this.peerConn.getRemoteStreams()[0];
    this.type = this.remoteStream.getTracks().some((t) => t.kind === 'video')
      ? CallType.Video
      : CallType.Voice;

    this.setState(CallState.Ringing);
    this.direction = CallDirection.Inbound;
    this.opponentVersion = this.msg.version;
    this.opponentPartyId = this.msg.party_id || null;

    if (event.getLocalAge()) {
      const timeoutDuration = this.msg.lifetime - <number>event.getLocalAge();
      setTimeout(() => {
        if (this.state === CallState.Ringing) {
          logger.debug('MyMatrixCall invite has expired. Hanging up.');
          this.hangupParty = CallParty.Remote; // effectively
          this.setState(CallState.Ended);
          this.stopAllMedia();
          if (this.peerConn?.signalingState !== 'closed') {
            this.peerConn?.close();
          }
          this.emit(CallEvent.Hangup);
        }
      }, timeoutDuration);
    }
  }

  /**
   * Configure this call from a hangup or reject event. Used by MatrixClient.
   * @param {MatrixEvent} event The m.call.hangup event
   */
  initWithHangup(event: MatrixEvent) {
    // perverse as it may seem, sometimes we want to instantiate a call with a
    // hangup message (because when getting the state of the room on load, events
    // come in reverse order and we want to remember that a call has been hung up)
    this.msg = event.getContent();
    this.setState(CallState.Ended);
  }

  /**
   * Answer a call.
   */
  async answer() {
    if (this.inviteOrAnswerSent) {
      return;
    }

    logger.debug(`Answering call ${this.callId} of type ${this.type}`);

    if (!this.localAVStream && !this.waitForLocalAVStream) {
      const constraints = getUserMediaVideoContraints(this.type);
      logger.log('MyMatrixGetting user media with constraints', constraints);
      this.setState(CallState.WaitLocalMedia);
      this.waitForLocalAVStream = true;

      try {
        const mediaStream = await mediaDevices.getUserMedia(constraints);
        this.waitForLocalAVStream = false;
        this.gotUserMediaForAnswer(<MediaStream>mediaStream);
      } catch (e) {
        this.getUserMediaFailed(e);
        return;
      }
    } else if (this.localAVStream) {
      this.gotUserMediaForAnswer(this.localAVStream);
    } else if (this.waitForLocalAVStream) {
      this.setState(CallState.WaitLocalMedia);
    }
  }

  /**
   * Replace this call with a new call, e.g. for glare resolution. Used by
   * MatrixClient.
   * @param {MatrixCall} newCall The new call.
   */
  replacedBy(newCall: MatrixCall) {
    logger.debug(this.callId + ' being replaced by ' + newCall.callId);
    if (this.state === CallState.WaitLocalMedia) {
      logger.debug('MyMatrixTelling new call to wait for local media');
      newCall.waitForLocalAVStream = true;
    } else if (this.state === CallState.CreateOffer) {
      logger.debug('MyMatrixHanding local stream to new call');
      newCall.gotUserMediaForAnswer(this.localAVStream);
    } else if (this.state === CallState.InviteSent) {
      logger.debug('MyMatrixHanding local stream to new call');
      // newCall.gotUserMediaForAnswer(this.localAVStream);
    }
    this.successor = newCall;
    this.emit(CallEvent.Replaced, newCall);
    this.hangup(CallErrorCode.Replaced, true);
  }

  /**
   * Hangup a call.
   * @param {string} reason The reason why the call is being hung up.
   * @param {boolean} suppressEvent True to suppress emitting an event.
   */
  hangup(reason: CallErrorCode, suppressEvent: boolean) {
    if (this.callHasEnded()) return;

    logger.debug('MyMatrixEnding call ' + this.callId);
    this.terminate(CallParty.Local, reason, !suppressEvent);
    const content = {};
    // Continue to send no reason for user hangups temporarily, until
    // clients understand the user_hangup reason (voip v1)
    if (reason !== CallErrorCode.UserHangup) content.reason = reason;
    this.sendVoipEvent('m.call.hangup', {});
  }

  /**
   * Reject a call
   * This used to be done by calling hangup, but is a separate method and protocol
   * event as of MSC2746.
   */
  reject() {
    if (this.state !== CallState.Ringing) {
      throw Error("Call must be in 'ringing' state to reject!");
    }

    if (this.opponentVersion < 1) {
      logger.info(
        `Opponent version is less than 1 (${this.opponentVersion}): sending hangup instead of reject`,
      );
      this.hangup(CallErrorCode.UserHangup, true);
      return;
    }

    logger.debug('MyMatrixRejecting call: ' + this.callId);
    this.terminate(CallParty.Local, CallErrorCode.UserHangup, true);
    this.sendVoipEvent('m.call.reject', {});
  }

  /**
   * Set whether our outbound video should be muted or not.
   * @param {boolean} muted True to mute the outbound video.
   */
  setLocalVideoMuted(muted: boolean) {
    this.vidMuted = muted;
    this.updateMuteStatus();
  }

  /**
   * Check if local video is muted.
   *
   * If there are multiple video tracks, <i>all</i> of the tracks need to be muted
   * for this to return true. This means if there are no video tracks, this will
   * return true.
   * @return {Boolean} True if the local preview video is muted, else false
   * (including if the call is not set up yet).
   */
  isLocalVideoMuted(): boolean {
    return this.vidMuted;
  }

  /**
   * Set whether the microphone should be muted or not.
   * @param {boolean} muted True to mute the mic.
   */
  setMicrophoneMuted(muted: boolean) {
    this.micMuted = muted;
    this.updateMuteStatus();
  }

  /**
   * Check if the microphone is muted.
   *
   * If there are multiple audio tracks, <i>all</i> of the tracks need to be muted
   * for this to return true. This means if there are no audio tracks, this will
   * return true.
   * @return {Boolean} True if the mic is muted, else false (including if the call
   * is not set up yet).
   */
  isMicrophoneMuted(): boolean {
    return this.micMuted;
  }

  /**
   * @returns true if we have put the party on the other side of the call on hold
   * (that is, we are signalling to them that we are not listening)
   */
  isRemoteOnHold(): boolean {
    return this.remoteOnHold;
  }

  setRemoteOnHold(onHold: boolean) {
    if (this.isRemoteOnHold() === onHold) return;
    this.remoteOnHold = onHold;

    /** 
    for (const tranceiver of this.peerConn?.getTransceivers()) {
      // We set 'inactive' rather than 'sendonly' because we're not planning on
      // playing music etc. to the other side.
      tranceiver.direction = onHold ? 'inactive' : 'sendrecv';
    }*/
    this.updateMuteStatus();
  }

  /**
   * Indicates whether we are 'on hold' to the remote party (ie. if true,
   * they cannot hear us). Note that this will return true when we put the
   * remote on hold too due to the way hold is implemented (since we don't
   * wish to play hold music when we put a call on hold, we use 'inactive'
   * rather than 'sendonly')
   * @returns true if the other party has put us on hold
   */
  isLocalOnHold(): boolean {
    if (this.state !== CallState.Connected) return false;

    const callOnHold = true;
    return callOnHold;
  }

  private updateMuteStatus() {
    if (!this.localAVStream) {
      return;
    }

    const micShouldBeMuted = this.micMuted || this.remoteOnHold;
    setTracksEnabled(this.localAVStream.getAudioTracks(), !micShouldBeMuted);

    const vidShouldBeMuted = this.vidMuted || this.remoteOnHold;
    setTracksEnabled(this.localAVStream.getVideoTracks(), !vidShouldBeMuted);
  }

  /**
   * Internal
   * @param {Object} stream
   */
  private gotUserMediaForInvite = async (stream: MediaStream) => {
    if (this.successor) {
      this.successor.gotUserMediaForAnswer(stream);
      return;
    }
    if (this.callHasEnded()) {
      return;
    }

    this.setState(CallState.CreateOffer);

    logger.debug('MyMatrixgotUserMediaForInvite -> ' + this.type);

    this.localAVStream = stream;
    logger.info(
      'MyMatrixGot local AV stream with id ' + this.localAVStream.id,
    );
    // why do we enable audio (and only audio) tracks here? -- matthew
    setTracksEnabled(stream.getAudioTracks(), true);
    this.peerConn = this.createPeerConnection();

    this.peerConn.addStream(stream);

    /*
    for (const audioTrack of stream.getAudioTracks()) {
      logger.info('MyMatrixAdding audio track with id ' + audioTrack.id);
      stream.addTrack(audioTrack);
      this.peerConn.addStream(stream);
      //this.peerConn?.addTrack(audioTrack, stream);
    }
    for (const videoTrack of (
      this.screenSharingStream || stream
    ).getVideoTracks()) {
      logger.info('MyMatrixAdding audio track with id ' + videoTrack.id);
     // this.peerConn?.addTrack(videoTrack, stream);
    }*/

    // Now we wait for the negotiationneeded event
  };

  private sendAnswer() {
    const answerContent = {
      answer: {
        sdp: this.peerConn?.localDescription.sdp,
        // type is now deprecated as of Matrix VoIP v1, but
        // required to still be sent for backwards compat
        type: this.peerConn?.localDescription.type,
      },
    };
    // We have just taken the local description from the peerconnection which will
    // contain all the local candidates added so far, so we can discard any candidates
    // we had queued up because they'll be in the answer.
    logger.info(
      `Discarding ${this.candidateSendQueue.length} candidates that will be sent in answer`,
    );
    this.candidateSendQueue = [];

    this.sendVoipEvent('m.call.answer', answerContent)
      .then(() => {
        // If this isn't the first time we've tried to send the answer,
        // we may have candidates queued up, so send them now.
        this.inviteOrAnswerSent = true;
        this.sendCandidateQueue();
      })
      .catch((error) => {
        // We've failed to answer: back to the ringing state
        this.setState(CallState.Ringing);
        this.client.cancelPendingEvent(error.event);

        let code = CallErrorCode.SendAnswer;
        let message = 'Failed to send answer';
        if (error.name == 'UnknownDeviceError') {
          code = CallErrorCode.UnknownDevices;
          message = 'Unknown devices present in the room';
        }
        this.emit(CallEvent.Error, new CallError(code, message, error));
        throw error;
      });
  }

  private gotUserMediaForAnswer = async (stream: MediaStream) => {
    if (this.callHasEnded()) {
      return;
    }

    this.localAVStream = stream;
    logger.info(
      'MyMatrixGot local AV stream with id ' + this.localAVStream.id,
    );
    setTracksEnabled(stream.getAudioTracks(), true);

    /*    
    for (const track of stream.getTracks()) {
      this.peerConn?.addTrack(track, stream);
    }
    */
    this.peerConn?.addStream(stream);

    this.setState(CallState.CreateAnswer);

    let myAnswer;
    try {
      myAnswer = await this.peerConn?.createAnswer();
    } catch (err) {
      logger.debug('MyMatrixFailed to create answer: ', err);
      this.terminate(CallParty.Local, CallErrorCode.CreateAnswer, true);
      return;
    }

    try {
      await this.peerConn?.setLocalDescription(myAnswer);
      this.setState(CallState.Connecting);

      // Allow a short time for initial candidates to be gathered
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });

      this.sendAnswer();
    } catch (err) {
      logger.debug('MyMatrixError setting local description!', err);
      this.terminate(CallParty.Local, CallErrorCode.SetLocalDescription, true);
      return;
    }
  };

  /**
   * Internal
   * @param {Object} event
   */
  private gotLocalIceCandidate = (event: EventOnCandidate) => {
    if (event.candidate) {
      logger.debug(
        'Got local ICE ' +
          event.candidate.sdpMid +
          ' candidate: ' +
          event.candidate.candidate,
      );

      if (this.callHasEnded()) return;

      // As with the offer, note we need to make a copy of this object, not
      // pass the original: that broke in Chrome ~m43.
      if (event.candidate.candidate !== '' || !this.sentEndOfCandidates) {
        this.queueCandidate(new RTCIceCandidate(event.candidate));

        if (event.candidate.candidate === '') this.sentEndOfCandidates = true;
      }
    }
  };

  private onIceGatheringStateChange = () => {
    logger.debug(
      'ice gathering state changed to ' + this.peerConn?.iceGatheringState,
    );
    if (
      this.peerConn?.iceGatheringState === 'complete' &&
      !this.sentEndOfCandidates
    ) {
      // If we didn't get an empty-string candidate to signal the end of candidates,
      // create one ourselves now gathering has finished.
      // We cast because the interface lists all the properties as required but we
      // only want to send 'candidate'
      // XXX: We probably want to send either sdpMid or sdpMLineIndex, as it's not strictly
      // correct to have a candidate that lacks both of these. We'd have to figure out what
      // previous candidates had been sent with and copy them.
      const c = {
        candidate: '',
      } as RTCIceCandidate;
      this.queueCandidate(c);
      this.sentEndOfCandidates = true;
    }
  };

  onRemoteIceCandidatesReceived(ev: MatrixEvent) {
    if (this.callHasEnded()) {
      //debuglog("Ignoring remote ICE candidate because call has ended");
      return;
    }

    if (!this.partyIdMatches(ev.getContent())) {
      logger.info(
        `Ignoring candidates from party ID ${ev.getContent().party_id}: ` +
          `we have chosen party ID ${this.opponentPartyId}`,
      );
      return;
    }

    const cands = ev.getContent().candidates;
    if (!cands) {
      logger.info('MyMatrixIgnoring candidates event with no candidates!');
      return;
    }

    for (const cand of cands) {
      if (
        (cand.sdpMid === null || cand.sdpMid === undefined) &&
        (cand.sdpMLineIndex === null || cand.sdpMLineIndex === undefined)
      ) {
        logger.debug(
          'Ignoring remote ICE candidate with no sdpMid or sdpMLineIndex',
        );
        return;
      }
      logger.debug(
        'Got remote ICE ' + cand.sdpMid + ' candidate: ' + cand.candidate,
      );
      try {
        this.peerConn?.addIceCandidate(cand);
      } catch (err) {
        if (!this.ignoreOffer) {
          logger.info('MyMatrixFailed to add remore ICE candidate', err);
        }
      }
    }
  }

  /**
   * Used by MatrixClient.
   * @param {Object} msg
   */
  async onAnswerReceived(event: MatrixEvent) {
    if (this.callHasEnded()) {
      return;
    }

    if (this.opponentPartyId !== undefined) {
      logger.info(
        `Ignoring answer from party ID ${event.getContent().party_id}: ` +
          `we already have an answer/reject from ${this.opponentPartyId}`,
      );
      return;
    }

    this.opponentVersion = event.getContent().version;
    this.opponentPartyId = event.getContent().party_id || null;

    this.setState(CallState.Connecting);

    try {
      await this.peerConn?.setRemoteDescription(event.getContent().answer);
    } catch (e) {
      logger.debug('MyMatrixFailed to set remote description', e);
      this.terminate(
        CallParty.Local,
        CallErrorCode.SetRemoteDescription,
        false,
      );
      return;
    }

    // If the answer we selected has a party_id, send a select_answer event
    // We do this after setting the remote description since otherwise we'd block
    // call setup on it
    if (this.opponentPartyId !== null) {
      try {
        // EventType.CallSelectAnswer
        await this.sendVoipEvent('m.call.select_answer', {
          selected_party_id: this.opponentPartyId,
        });
      } catch (err) {
        // This isn't fatal, and will just mean that if another party has raced to answer
        // the call, they won't know they got rejected, so we carry on & don't retry.
        logger.warn('Failed to send select_answer event', err);
      }
    }
  }

  async onSelectAnswerReceived(event: MatrixEvent) {
    if (this.direction !== CallDirection.Inbound) {
      logger.warn('Got select_answer for an outbound call: ignoring');
      return;
    }

    const selectedPartyId = event.getContent().selected_party_id;

    if (selectedPartyId === undefined || selectedPartyId === null) {
      logger.warn(
        'Got nonsensical select_answer with null/undefined selected_party_id: ignoring',
      );
      return;
    }

    if (selectedPartyId !== this.ourPartyId) {
      logger.info(
        `Got select_answer for party ID ${selectedPartyId}: we are party ID ${this.ourPartyId}.`,
      );
      // The other party has picked somebody else's answer
      this.terminate(CallParty.Remote, CallErrorCode.AnsweredElsewhere, true);
    }
  }

  async onNegotiateReceived(event: MatrixEvent) {
    const description = event.getContent().description;
    if (!description || !description.sdp || !description.type) {
      logger.info('MyMatrixIgnoring invalid m.call.negotiate event');
      return;
    }
    // Politeness always follows the direction of the call: in a glare situation,
    // we pick either the inbound or outbound call, so one side will always be
    // inbound and one outbound
    const polite = this.direction === CallDirection.Inbound;

    // Here we follow the perfect negotiation logic from
    // https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
    const offerCollision =
      description.type == 'offer' &&
      (this.makingOffer || this.peerConn?.signalingState != 'stable');

    this.ignoreOffer = !polite && offerCollision;
    if (this.ignoreOffer) {
      logger.info("Ignoring colliding negotiate event because we're impolite");
      return;
    }

    const prevOnHold = this.isLocalOnHold();

    try {
      await this.peerConn?.setRemoteDescription(description);

      if (description.type === 'offer') {
        const localDescription = await this.peerConn?.createAnswer();
        await this.peerConn?.setLocalDescription(localDescription);

        this.sendVoipEvent('m.call.negotiate', {
          description: this.peerConn?.localDescription,
        });
      }
    } catch (err) {
      logger.warn('Failed to complete negotiation', err);
    }

    const nowOnHold = this.isLocalOnHold();
    if (prevOnHold !== nowOnHold) {
      this.emit(CallEvent.HoldUnhold, nowOnHold);
    }
  }

  private callHasEnded(): boolean {
    // This exists as workaround to typescript trying to be clever and erroring
    // when putting if (this.state === CallState.Ended) return; twice in the same
    // function, even though that function is async.
    return this.state === CallState.Ended;
  }

  private gotLocalOffer = async (description: RTCSessionDescriptionInit) => {
    logger.debug('MyMatrixCreated offer: ', description);

    if (this.callHasEnded()) {
      logger.debug(
        'Ignoring newly created offer on call ID ' +
          this.callId +
          ' because the call has ended',
      );
      return;
    }

    try {
      await this.peerConn?.setLocalDescription(description);
    } catch (err) {
      logger.debug('MyMatrixError setting local description!', err);
      this.terminate(CallParty.Local, CallErrorCode.SetLocalDescription, true);
      return;
    }
    if (this.peerConn?.iceGatheringState === 'gathering') {
      // Allow a short time for initial candidates to be gathered
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }

    if (this.callHasEnded()) return;

    const keyName =
      this.state === CallState.CreateOffer ? 'offer' : 'description';
    const eventType =
      this.state === CallState.CreateOffer
        ? 'm.call.invite' //EventType.CallInvite
        : 'm.call.negotiate'; //EventType.CallNegotiate;

    const content = {
      [keyName]: this.peerConn?.localDescription,
      lifetime: CALL_TIMEOUT_MS,
    };

    // Get rid of any candidates waiting to be sent: they'll be included in the local
    // description we just got and will send in the offer.
    logger.info(
      `Discarding ${this.candidateSendQueue.length} candidates that will be sent in offer`,
    );
    this.candidateSendQueue = [];

    try {
      await this.sendVoipEvent(eventType, content);
      this.sendCandidateQueue();
      if (this.state === CallState.CreateOffer) {
        this.inviteOrAnswerSent = true;
        this.setState(CallState.InviteSent);
        this.inviteTimeout = setTimeout(() => {
          this.inviteTimeout = null;
          if (this.state === CallState.InviteSent) {
            this.hangup(CallErrorCode.InviteTimeout, false);
          }
        }, CALL_TIMEOUT_MS);
      }
    } catch (error) {
      this.client.cancelPendingEvent(error.event);

      let code = CallErrorCode.SignallingFailed;
      let message = 'Signalling failed';
      if (this.state === CallState.CreateOffer) {
        code = CallErrorCode.SendInvite;
        message = 'Failed to send invite';
      }
      if (error.name == 'UnknownDeviceError') {
        code = CallErrorCode.UnknownDevices;
        message = 'Unknown devices present in the room';
      }

      this.emit(CallEvent.Error, new CallError(code, message, error));
      this.terminate(CallParty.Local, code, false);
    }
  };

  private getLocalOfferFailed = (err: Error) => {
    logger.error('MyMatrixFailed to get local offer', err);

    this.emit(
      CallEvent.Error,
      new CallError(
        CallErrorCode.LocalOfferFailed,
        'Failed to get local offer!',
        err,
      ),
    );
    this.terminate(CallParty.Local, CallErrorCode.LocalOfferFailed, false);
  };

  private getUserMediaFailed = (err: Error) => {
    if (this.successor) {
      this.successor.getUserMediaFailed(err);
      return;
    }

    logger.warn('Failed to get user media - ending call', err);

    this.emit(
      CallEvent.Error,
      new CallError(
        CallErrorCode.NoUserMedia,
        "Couldn't start capturing media! Is your microphone set up and " +
          'does this app have permission?',
        err,
      ),
    );
    this.terminate(CallParty.Local, CallErrorCode.NoUserMedia, false);
  };

  onIceConnectionStateChanged = () => {
    if (this.callHasEnded()) {
      return; // because ICE can still complete as we're ending the call
    }
    logger.debug(
      'ICE connection state changed to: ' + this.peerConn?.iceConnectionState,
    );
    // ideally we'd consider the call to be connected when we get media but
    // chrome doesn't implement any of the 'onstarted' events yet
    if (this.peerConn?.iceConnectionState == 'connected') {
      this.setState(CallState.Connected);
    } else if (this.peerConn?.iceConnectionState == 'failed') {
      this.hangup(CallErrorCode.IceFailed, false);
    }
  };

  private onSignallingStateChanged = () => {
    logger.debug(
      'call ' +
        this.callId +
        ': Signalling state changed to: ' +
        this.peerConn?.signalingState,
    );
  };

  onNegotiationNeeded = async () => {
    logger.info('MyMatrixNegotation is needed!');

    if (this.state !== CallState.CreateOffer && this.opponentVersion === 0) {
      logger.info(
        'Opponent does not support renegotiation: ignoring negotiationneeded event',
      );
      return;
    }

    this.makingOffer = true;
    try {
      logger.log('MyMatrix onNegotiationNeeded create offer');
      const myOffer = await this.peerConn?.createOffer();
      logger.log('MyMatrix onNegotiationNeeded create offer', myOffer);
      await this.gotLocalOffer(myOffer);
    } catch (e) {
      this.getLocalOfferFailed(e);
      return;
    } finally {
      this.makingOffer = false;
    }
  };

  playRemoteAudio() {
    logger.log('MyMatrixplayRemoteAudio');
    /*
    this.queueMediaOperation(MediaQueueId.RemoteAudio, async () => {

        this.remoteAudioElement.srcObject = this.remoteStream;

      // if audioOutput is non-default:
      try {
        if (audioOutput) {
          // This seems quite unreliable in Chrome, although I haven't yet managed to make a jsfiddle where
          // it fails.
          // It seems reliable if you set the sink ID after setting the srcObject and then set the sink ID
          // back to the default after the call is over
          logger.info(
            'Setting audio sink to ' +
              audioOutput +
              ', was ' +
              this.remoteAudioElement.sinkId,
          );
          await this.remoteAudioElement.setSinkId(audioOutput);
        }
      } catch (e) {
        logger.warn(
          "Couldn't set requested audio output device: using default",
          e,
        );
      }

      try {
        await this.remoteAudioElement.play();
      } catch (e) {
        logger.error('MyMatrixFailed to play remote video element', e);
      }
    });
    */
  }

  onHangupReceived = (msg) => {
    logger.debug('MyMatrixHangup received');

    // party ID must match (our chosen partner hanging up the call) or be undefined (we haven't chosen
    // a partner yet but we're treating the hangup as a reject as per VoIP v0)
    if (!this.partyIdMatches(msg) && this.opponentPartyId !== undefined) {
      logger.info(
        `Ignoring message from party ID ${msg.party_id}: our partner is ${this.opponentPartyId}`,
      );
      return;
    }

    // default reason is user_hangup
    this.terminate(
      CallParty.Remote,
      msg.reason || CallErrorCode.UserHangup,
      true,
    );
  };

  onRejectReceived = (msg) => {
    logger.debug('MyMatrixReject received', msg);

    // No need to check party_id for reject because if we'd received either
    // an answer or reject, we wouldn't be in state InviteSent

    if (this.state === CallState.InviteSent) {
      this.terminate(CallParty.Remote, CallErrorCode.UserHangup, true);
    } else {
      logger.debug(`Call is in state: ${this.state}: ignoring reject`);
    }
  };

  onAnsweredElsewhere = (msg) => {
    logger.debug('MyMatrixAnswered elsewhere', msg);
    this.terminate(CallParty.Remote, CallErrorCode.AnsweredElsewhere, true);
  };

  setState(state: CallState) {
    const oldState = this.state;
    this.state = state;
    this.emit(CallEvent.State, state, oldState);
  }

  /**
   * Internal
   * @param {string} eventType
   * @param {Object} content
   * @return {Promise}
   */
  private sendVoipEvent(eventType: string, content: object) {
    return this.client.sendEvent(
      this.roomId,
      eventType,
      Object.assign({}, content, {
        version: VOIP_PROTO_VERSION,
        call_id: this.callId,
        party_id: this.ourPartyId,
      }),
    );
  }

  queueCandidate(content: RTCIceCandidate) {
    // Sends candidates with are sent in a special way because we try to amalgamate
    // them into one message
    this.candidateSendQueue.push(content);

    // Don't send the ICE candidates yet if the call is in the ringing state: this
    // means we tried to pick (ie. started generating candidates) and then failed to
    // send the answer and went back to the ringing state. Queue up the candidates
    // to send if we sucessfully send the answer.
    // Equally don't send if we haven't yet sent the answer because we can send the
    // first batch of candidates along with the answer
    if (this.state === CallState.Ringing || !this.inviteOrAnswerSent) return;

    // MSC2746 reccomends these values (can be quite long when calling because the
    // callee will need a while to answer the call)
    const delay = this.direction === CallDirection.Inbound ? 500 : 2000;

    if (this.candidateSendTries === 0) {
      setTimeout(() => {
        this.sendCandidateQueue();
      }, delay);
    }
  }

  private terminate(
    hangupParty: CallParty,
    hangupReason: CallErrorCode,
    shouldEmit: boolean,
  ) {
    if (this.callHasEnded()) return;

    if (this.inviteTimeout) {
      clearTimeout(this.inviteTimeout);
      this.inviteTimeout = null;
    }

    this.hangupParty = hangupParty;
    this.hangupReason = hangupReason;
    this.setState(CallState.Ended);
    this.stopAllMedia();
    if (this.peerConn && this.peerConn?.signalingState !== 'closed') {
      this.peerConn?.close();
    }
    if (shouldEmit) {
      this.emit(CallEvent.Hangup, this);
    }
  }

  private stopAllMedia() {
    logger.debug(`stopAllMedia (stream=${this.localAVStream})`);
    if (this.localAVStream) {
      for (const track of this.localAVStream.getTracks()) {
        track.stop();
      }
    }
    if (this.screenSharingStream) {
      for (const track of this.screenSharingStream.getTracks()) {
        track.stop();
      }
    }

    if (this.remoteStream) {
      for (const track of this.remoteStream.getTracks()) {
        track.stop();
      }
    }
  }

  private checkForErrorListener() {
    if (this.listeners('error').length === 0) {
      throw new Error(
        "You MUST attach an error listener using call.on('error', function() {})",
      );
    }
  }

  private sendCandidateQueue() {
    if (this.candidateSendQueue.length === 0) {
      return;
    }

    const cands = this.candidateSendQueue;
    this.candidateSendQueue = [];
    ++this.candidateSendTries;
    const content = {
      candidates: cands,
    };
    logger.debug('MyMatrixAttempting to send ' + cands.length + ' candidates');
    this.sendVoipEvent(
      'm.call.candidates' /*EventType.CallCandidates*/,
      content,
    ).then(
      () => {
        this.candidateSendTries = 0;
        this.sendCandidateQueue();
      },
      (error) => {
        for (let i = 0; i < cands.length; i++) {
          this.candidateSendQueue.push(cands[i]);
        }

        if (this.candidateSendTries > 5) {
          logger.debug(
            'Failed to send candidates on attempt ' +
              this.candidateSendTries +
              '. Giving up for now.',
            error,
          );
          this.candidateSendTries = 0;
          return;
        }

        const delayMs = 500 * Math.pow(2, this.candidateSendTries);
        ++this.candidateSendTries;
        logger.debug(
          'Failed to send candidates. Retrying in ' + delayMs + 'ms',
          error,
        );
        setTimeout(() => {
          this.sendCandidateQueue();
        }, delayMs);
      },
    );
  }

  private async placeCallWithConstraints(constraints: MediaStreamConstraints) {
    logger.log('MyMatrixGetting user media with constraints', constraints);
    // XXX Find a better way to do this
    this.client._callEventHandler.calls.set(this.callId, this);
    this.setState(CallState.WaitLocalMedia);
    this.direction = CallDirection.Outbound;
    this.config = constraints;
    // It would be really nice if we could start gathering candidates at this point
    // so the ICE agent could be gathering while we open our media devices: we already
    // know the type of the call and therefore what tracks we want to send.
    // Perhaps we could do this by making fake tracks now and then using replaceTrack()
    // once we have the actual tracks? (Can we make fake tracks?)
    try {
      const mediaStream = await mediaDevices.getUserMedia(constraints);
      if (mediaStream instanceof MediaStream) {
        this.gotUserMediaForInvite(mediaStream);
      } else {
        this.getUserMediaFailed(
          new Error('mediaStream is not instance of MediaStream Failed'),
        );
      }
    } catch (e) {
      this.getUserMediaFailed(e);
      return;
    }
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceTransportPolicy: this.forceTURN ? 'relay' : undefined,
      iceServers: this.turnServers,
    });

    // 'connectionstatechange' would be better, but firefox doesn't implement that.
    pc.oniceconnectionstatechange = this.onIceConnectionStateChanged;
    pc.onsignalingstatechange = this.onSignallingStateChanged;
    pc.onicecandidate = this.gotLocalIceCandidate;
    pc.onicegatheringstatechange = this.onIceGatheringStateChange;
    // @TODO pc.addEventListener('track', this.onTrack);
    pc.onnegotiationneeded = () => {
      this.onNegotiationNeeded();
    };

    return pc;
  }

  private partyIdMatches(msg): boolean {
    // They must either match or both be absent (in which case opponentPartyId will be null)
    const msgPartyId = msg.party_id || null;
    return msgPartyId === this.opponentPartyId;
  }
}

function setTracksEnabled(tracks: Array<MediaStreamTrack>, enabled: boolean) {
  for (let i = 0; i < tracks.length; i++) {
    tracks[i].enabled = enabled;
  }
}

function getUserMediaVideoContraints(callType: CallType | null) {
  switch (callType) {
    case CallType.Voice:
      return {
        audio: true,
        video: false,
      };
    case CallType.Video:
      return {
        audio: false,
        video: false,
      };
  }
}

let audioOutput: string;
let audioInput: string;
let videoInput: string;
/**
 * Set an audio output device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setAudioOutput(deviceId: string) { audioOutput = deviceId; }
/**
 * Set an audio input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setAudioInput(deviceId: string) { audioInput = deviceId; }
/**
 * Set a video input device to use for MatrixCalls
 * @function
 * @param {string=} deviceId the identifier for the device
 * undefined treated as unset
 */
export function setVideoInput(deviceId: string) { videoInput = deviceId; }

/**
 * Create a new Matrix call for the browser.
 * @param {MatrixClient} client The client instance to use.
 * @param {string} roomId The room the call is in.
 * @param {Object?} options DEPRECATED optional options map.
 * @param {boolean} options.forceTURN DEPRECATED whether relay through TURN should be
 * forced. This option is deprecated - use opts.forceTURN when creating the matrix client
 * since it's only possible to set this option on outbound calls.
 * @return {MatrixCall} the call or null if the browser doesn't support calling.
 */
export function createNewMatrixCall(
  client: any,
  roomId: string,
  options?: CallOpts,
) {
  const optionsForceTURN = options ? options.forceTURN : false;

  const opts = {
    client: client,
    roomId: roomId,
    turnServers: client.getTurnServers(),
    // call level options
    forceTURN: client._forceTURN || optionsForceTURN,
  };
  return new MatrixCall(opts);
}
