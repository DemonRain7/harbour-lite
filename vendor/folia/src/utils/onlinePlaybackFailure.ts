import { OnlineProviderError } from '../types/onlineMusic';

// src/utils/onlinePlaybackFailure.ts
// An audio request failing is not evidence that the provider removed the song.
export type OnlinePlaybackFailureReason =
    | 'auth-required'
    | 'network'
    | 'no-source'
    | 'unsupported'
    | 'provider-unavailable'
    | 'invalid-response'
    | 'unknown';

export function getOnlinePlaybackFailureReason(error: unknown): OnlinePlaybackFailureReason {
    if (!(error instanceof OnlineProviderError)) return 'unknown';
    switch (error.code) {
        case 'auth-required':
        case 'network':
        case 'unsupported':
        case 'invalid-response':
            return error.code;
        case 'not-playable':
            return 'no-source';
        case 'unavailable':
            return 'provider-unavailable';
        default:
            return 'unknown';
    }
}

const messageKeys = {
    'auth-required': 'status.playbackAuthRequired',
    network: 'status.playbackNetworkError',
    'no-source': 'status.playbackNoSource',
    unsupported: 'status.playbackUnsupported',
    'provider-unavailable': 'status.playbackProviderUnavailable',
    'invalid-response': 'status.playbackInvalidResponse',
    unknown: 'status.playbackRequestFailed',
} as const;

export const getOnlinePlaybackFailureMessageKey = (reason: OnlinePlaybackFailureReason = 'unknown') => messageKeys[reason];
