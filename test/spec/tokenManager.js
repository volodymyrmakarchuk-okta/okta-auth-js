/* global window, localStorage, sessionStorage */

// Promise.allSettled is added in Node 12.10
import allSettled from 'promise.allsettled';
allSettled.shim(); // will be a no-op if not needed

import Emitter from 'tiny-emitter';
import { OktaAuth, AuthSdkError } from '@okta/okta-auth-js';
import tokens from '@okta/test.support/tokens';
import util from '@okta/test.support/util';
import oauthUtil from '@okta/test.support/oauthUtil';
import SdkClock from '../../lib/clock';

// Expected settings on HTTPS
var secureCookieSettings = {
  secure: true,
  sameSite: 'none'
};

function createAuth(options) {
  options = options || {};
  options.tokenManager = options.tokenManager || {};
  jest.spyOn(SdkClock, 'create').mockReturnValue(new SdkClock(options.localClockOffset));
  return new OktaAuth({
    pkce: false,
    issuer: 'https://auth-js-test.okta.com',
    clientId: 'NPSfOkH5eZrTy8PMDlvx',
    redirectUri: 'https://example.com/redirect',
    tokenManager: {
      expireEarlySeconds: options.tokenManager.expireEarlySeconds || 0,
      storage: options.tokenManager.storage,
      storageKey: options.tokenManager.storageKey,
      autoRenew: options.tokenManager.autoRenew || false,
      secure: options.tokenManager.secure, // used by cookie storage
    }
  });
}

describe('TokenManager', function() {
  let originalLocation;
  let client;

  function setupSync(options) {
    client = createAuth(options);
    return client;
  }

  beforeEach(function() {
    localStorage.clear();
    sessionStorage.clear();

    // Mock window.location so we appear to be on an HTTPS origin
    originalLocation = global.window.location;
    delete global.window.location;
    global.window.location = {
      protocol: 'https:',
      hostname: 'somesite.local'
    };
  });
  afterEach(function() {
    if (client) {
      client.tokenManager.clear();
    }
    global.window.location = originalLocation;
    jest.useRealTimers();
  });

  describe('Event emitter', function() {
    it('uses emitter from the SDK client', function() {
      jest.spyOn(Emitter.prototype, 'on');
      setupSync();
      var handlerFn = jest.fn();
      client.tokenManager.on('fake', handlerFn);
      var emitter = Emitter.prototype.on.mock.instances[0];
      expect(emitter).toBe(client.emitter);
      emitter.emit('fake');
      expect(handlerFn).toHaveBeenCalled();
    });

    it('Can add event callbacks using on()', function() {
      setupSync();
      var handler = jest.fn();
      client.tokenManager.on('fake', handler);
      var payload = { foo: 'bar' };
      client.emitter.emit('fake', payload);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('Event callbacks can have an optional context', function() {
      setupSync();
      var context = jest.fn();
      var handler = jest.fn().mockImplementation(function() {
        expect(this).toBe(context);
      });
      client.tokenManager.on('fake', handler, context);
      var payload = { foo: 'bar' };
      client.emitter.emit('fake', payload);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('Can remove event callbacks using off()', function() {
      setupSync();
      var handler = jest.fn();
      client.tokenManager.on('fake', handler);
      client.tokenManager.off('fake', handler);
      var payload = { foo: 'bar' };
      client.emitter.emit('fake', payload);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('storageKey', function() {
    it('Uses "okta-token-storage" by default', function() {
      setupSync();
      expect(localStorage.getItem('okta-token-storage')).toBeFalsy();
      client.tokenManager.add('foo', tokens.standardIdTokenParsed);
      expect(localStorage.getItem('okta-token-storage')).toBeTruthy();
    });
    it('Can use a custom value', function() {
      setupSync({
        tokenManager: {
          storageKey: 'custom1'
        }
      });
      expect(localStorage.getItem('custom1')).toBeFalsy();
      client.tokenManager.add('foo', tokens.standardIdTokenParsed);
      expect(localStorage.getItem('custom1')).toBeTruthy();
      expect(localStorage.getItem('okta-token-storage')).toBeFalsy();
    });
  });
  describe('storage', function() {
    it('throws if storage option is unrecognized', function() {
      var fn = createAuth.bind(null, {
        tokenManager: {
          storage: 'unheardof'
        }
      });
      expect(fn).toThrowError('Unrecognized storage option');
    });
    it('has an in memory option', function() {
      // warp to time to ensure tokens aren't expired
      util.warpToUnixTime(tokens.standardIdTokenClaims.exp - 1);

      setupSync({
        tokenManager: {
          storage: 'memory'
        }
      });
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      return client.tokenManager.get('test-idToken')
        .then(function (value) {
          expect(value).toEqual(tokens.standardIdTokenParsed);
        });
    });
    it('accepts a custom provider', function() {
      var store = {};
      var provider = {
        getItem: jest.fn().mockImplementation(function(key) { 
          return store[key];
        }),
        setItem: jest.fn().mockImplementation(function(key, val) {
          store[key] = val;
        })
      };
      setupSync({
        tokenManager: {
          storage: provider
        }
      });
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      oauthUtil.expectTokenStorageToEqual(provider, {
        'test-idToken': tokens.standardIdTokenParsed
      });
      expect(provider.setItem).toHaveBeenCalled();
      expect(provider.getItem).toHaveBeenCalled();
    });
  });

  describe('general', function() {
    it('defaults to localStorage', function() {
      setupSync();
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      oauthUtil.expectTokenStorageToEqual(localStorage, {
        'test-idToken': tokens.standardIdTokenParsed
      });
    });
    it('defaults to sessionStorage if localStorage isn\'t available', function() {
      jest.spyOn(window.console, 'log');
      oauthUtil.mockLocalStorageError();
      setupSync();
      expect(window.console.log).toHaveBeenCalledWith(
        '[okta-auth-sdk] WARN: This browser doesn\'t ' +
        'support localStorage. Switching to sessionStorage.'
      );
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      oauthUtil.expectTokenStorageToEqual(sessionStorage, {
        'test-idToken': tokens.standardIdTokenParsed
      });
    });
    it('defaults to sessionStorage if localStorage cannot be written to', function() {
      jest.spyOn(window.console, 'log');
      oauthUtil.mockStorageSetItemError();
      setupSync();
      expect(window.console.log).toHaveBeenCalledWith(
        '[okta-auth-sdk] WARN: This browser doesn\'t ' +
        'support localStorage. Switching to sessionStorage.'
      );
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      oauthUtil.expectTokenStorageToEqual(sessionStorage, {
        'test-idToken': tokens.standardIdTokenParsed
      });
    });
    it('defaults to cookie-based storage if localStorage and sessionStorage are not available', function() {
      jest.spyOn(window.console, 'log');
      oauthUtil.mockLocalStorageError();
      oauthUtil.mockSessionStorageError();
      setupSync();
      expect(window.console.log).toHaveBeenCalledWith(
        '[okta-auth-sdk] WARN: This browser doesn\'t ' +
        'support sessionStorage. Switching to cookie-based storage.'
      );
      var setCookieMock = util.mockSetCookie();
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      expect(setCookieMock).toHaveBeenCalledWith(
        'okta-token-storage_test-idToken',
        JSON.stringify(tokens.standardIdTokenParsed),
        '2200-01-01T00:00:00.000Z',
        secureCookieSettings
      );
    });
    it('defaults to cookie-based storage if sessionStorage cannot be written to', function() {
      jest.spyOn(window.console, 'log');
      oauthUtil.mockLocalStorageError();
      oauthUtil.mockStorageSetItemError();
      setupSync({
        tokenManager: {
          storage: 'sessionStorage'
        }
      });
      expect(window.console.log).toHaveBeenCalledWith(
        '[okta-auth-sdk] WARN: This browser doesn\'t ' +
        'support sessionStorage. Switching to cookie-based storage.'
      );
      var setCookieMock = util.mockSetCookie();
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      expect(setCookieMock).toHaveBeenCalledWith(
        'okta-token-storage_test-idToken',
        JSON.stringify(tokens.standardIdTokenParsed),
        '2200-01-01T00:00:00.000Z',
        secureCookieSettings
      );
    });
  });

  describe('add', function() {
    it('throws an error when attempting to add a non-token', function() {
      setupSync();
      try {
        client.tokenManager.add('test-idToken', [
          tokens.standardIdTokenParsed,
          tokens.standardIdTokenParsed
        ]);

        // Should never hit this
        expect(true).toEqual(false);
      } catch (e) {
        util.expectErrorToEqual(e, {
          name: 'AuthSdkError',
          message: 'Token must be an Object with scopes, expiresAt, and an idToken or accessToken properties',
          errorCode: 'INTERNAL',
          errorSummary: 'Token must be an Object with scopes, expiresAt, and an idToken or accessToken properties',
          errorLink: 'INTERNAL',
          errorId: 'INTERNAL',
          errorCauses: []
        });
      }
    });
  });

  describe('renew', function() {
    beforeEach(() => {
      setupSync();
    });

    it('on success, emits a "renewed" event with the new token', function() {
      var key = 'test-idToken';
      var origToken = tokens.standardIdTokenParsed;
      var renewedToken = Object.assign({}, origToken);
      client.tokenManager.add(key, origToken);
      jest.spyOn(client.token, 'renew').mockImplementation(function() {
        return Promise.resolve(renewedToken);
      });
      var callback = jest.fn();
      client.tokenManager.on('renewed', callback);
      return client.tokenManager.renew('test-idToken')
        .then(function() {
          expect(callback).toHaveBeenCalledWith(key, renewedToken, origToken);
        });
    });

    it('multiple overlapping calls will produce a single request and promise', function() {
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      jest.spyOn(client.token, 'renew').mockImplementation(function() {
        return Promise.resolve(tokens.standardIdTokenParsed);
      });
      var p1 = client.tokenManager.renew('test-idToken');
      var p2 = client.tokenManager.renew('test-idToken');
      expect(p1).toBe(p2);
      return Promise.all([p1, p2]);
    });

    it('multiple overlapping calls will produce a single request and promise (failure case)', function() {
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      jest.spyOn(client.token, 'renew').mockImplementation(function() {
        return Promise.reject(new Error('expected'));
      });
      var p1 = client.tokenManager.renew('test-idToken');
      var p2 = client.tokenManager.renew('test-idToken');
      expect(p1).toBe(p2);
      return Promise.allSettled([p1, p2]).then(function(results) {
        expect(results).toHaveLength(2);
        results.forEach(function(result) {
          expect(result.status).toBe('rejected');
          util.expectErrorToEqual(result.reason, {
            name: 'Error',
            message: 'expected',
          });
        });
      });
    });

    it('sequential calls will produce a unique request and promise', function() {
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      jest.spyOn(client.token, 'renew').mockImplementation(function() {
        return Promise.resolve(tokens.standardIdTokenParsed);
      });
      var p1 = client.tokenManager.renew('test-idToken').then(function() {
        var p2 = client.tokenManager.renew('test-idToken');
        expect(p1).not.toBe(p2);
        return p2;
      });
      return p1;
    });

    it('sequential calls will produce a unique request and promise (failure case)', function() {
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      jest.spyOn(client.token, 'renew').mockImplementation(function() {
        return Promise.reject(new Error('expected'));
      });
      var p1 = client.tokenManager.renew('test-idToken').then(function() {
        expect(false).toBe(true);
      }).catch(function(err) {
        util.expectErrorToEqual(err, {
          name: 'Error',
          message: 'expected',
        });
        var p2 = client.tokenManager.renew('test-idToken');
        expect(p1).not.toBe(p2);
        return p2;
      }).then(function() {
        expect(false).toBe(true);
      }).catch(function(err) {
        util.expectErrorToEqual(err, {
          name: 'Error',
          message: 'expected',
        });
      });
      return p1;
    });

    it('allows renewing an idToken', function() {
      return oauthUtil.setupFrame({
        authClient: client,
        tokenManagerAddKeys: {
          'test-idToken': {
            idToken: 'testInitialToken',
            claims: {'fake': 'claims'},
            expiresAt: 0,
            scopes: ['openid', 'email']
          }
        },
        tokenManagerRenewArgs: ['test-idToken'],
        postMessageSrc: {
          baseUri: 'https://auth-js-test.okta.com/oauth2/v1/authorize',
          queryParams: {
            'client_id': 'NPSfOkH5eZrTy8PMDlvx',
            'redirect_uri': 'https://example.com/redirect',
            'response_type': 'id_token',
            'response_mode': 'okta_post_message',
            'state': oauthUtil.mockedState,
            'nonce': oauthUtil.mockedNonce,
            'scope': 'openid email',
            'prompt': 'none'
          }
        },
        postMessageResp: {
          'id_token': tokens.standardIdToken,
          state: oauthUtil.mockedState
        },
        expectedResp: tokens.standardIdTokenParsed
      })
      .then(function() {
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });

    it('allows renewing an accessToken', function() {
      var expiresAt = tokens.standardAccessTokenParsed.expiresAt;
      var mockTime = expiresAt - 3600;

      return oauthUtil.setupFrame({
        authClient: client,
        tokenManagerAddKeys: {
          'accessToken': {
            accessToken: 'testInitialToken',
            expiresAt: mockTime + 100,
            scopes: ['openid', 'email'],
            tokenType: 'Bearer'
          }
        },
        time: mockTime,
        tokenManagerRenewArgs: ['accessToken'],
        postMessageSrc: {
          baseUri: 'https://auth-js-test.okta.com/oauth2/v1/authorize',
          queryParams: {
            'client_id': 'NPSfOkH5eZrTy8PMDlvx',
            'redirect_uri': 'https://example.com/redirect',
            'response_type': 'token',
            'response_mode': 'okta_post_message',
            'state': oauthUtil.mockedState,
            'nonce': oauthUtil.mockedNonce,
            'scope': 'openid email',
            'prompt': 'none'
          }
        },
        postMessageResp: {
          'access_token': tokens.standardAccessToken,
          'token_type': 'Bearer',
          'expires_in': 3600,
          'state': oauthUtil.mockedState
        },
        expectedResp: tokens.standardAccessTokenParsed
      })
      .then(function() {
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'accessToken': tokens.standardAccessTokenParsed
        });
      });
    });

    it('throws an errors when a token doesn\'t exist', () => {
      const error = {
        name: 'AuthSdkError',
        message: 'The tokenManager has no token for the key: test-accessToken',
        errorCode: 'INTERNAL',
        errorSummary: 'The tokenManager has no token for the key: test-accessToken',
        errorLink: 'INTERNAL',
        errorId: 'INTERNAL',
        errorCauses: []
      };
      return oauthUtil.setupFrame({
        willFail: true,
        authClient: client,
        tokenManagerRenewArgs: ['test-accessToken']
      })
      .catch(function(e) {
        util.expectErrorToEqual(e, error);
      });
    });

    it('throws an errors when the token is mangled', function() {
      localStorage.setItem('okta-token-storage', '#unparseableJson#');
      return oauthUtil.setupFrame({
        authClient: client,
        willFail: true,
        tokenManagerRenewArgs: ['test-accessToken']
      })
      .then(function() {
        expect(true).toEqual(false);
      })
      .catch(function(err) {
        util.expectErrorToEqual(err, {
          name: 'AuthSdkError',
          message: 'Unable to parse storage string: okta-token-storage',
          errorCode: 'INTERNAL',
          errorSummary: 'Unable to parse storage string: okta-token-storage',
          errorLink: 'INTERNAL',
          errorId: 'INTERNAL',
          errorCauses: []
        });
      });
    });

    it('throws an error if there\'s an issue renewing', () => {
      const error = {
        name: 'AuthSdkError',
        message: 'OAuth flow response nonce doesn\'t match request nonce',
        errorCode: 'INTERNAL',
        errorSummary: 'OAuth flow response nonce doesn\'t match request nonce',
        errorLink: 'INTERNAL',
        errorId: 'INTERNAL',
        errorCauses: [],
        tokenKey: 'test-idToken',
        accessToken: false
      };

      return oauthUtil.setupFrame({
        willFail: true,
        authClient: client,
        tokenManagerAddKeys: {
          'test-idToken': tokens.standardIdTokenParsed
        },
        tokenManagerRenewArgs: ['test-idToken'],
        postMessageSrc: {
          baseUri: 'https://auth-js-test.okta.com/oauth2/v1/authorize',
          queryParams: {
            'client_id': 'NPSfOkH5eZrTy8PMDlvx',
            'redirect_uri': 'https://example.com/redirect',
            'response_type': 'token',
            'response_mode': 'okta_post_message',
            'state': oauthUtil.mockedState,
            'nonce': oauthUtil.mockedNonce,
            'scope': 'openid email',
            'prompt': 'none'
          }
        },
        postMessageResp: {
          'id_token': tokens.modifiedIdToken,
          state: oauthUtil.mockedState
        }
      })
      .catch(function(e) {
        util.expectErrorToEqual(e, error);
      });
    });

    it('removes token if an OAuthError is thrown while renewing', function() {
      return oauthUtil.setupFrame({
        authClient: client,
        willFail: true,
        tokenManagerAddKeys: {
          'test-accessToken': tokens.standardAccessTokenParsed,
          'test-idToken': tokens.standardIdTokenParsed
        },
        tokenManagerRenewArgs: ['test-accessToken'],
        postMessageResp: {
          error: 'sampleErrorCode',
          'error_description': 'something went wrong',
          state: oauthUtil.mockedState
        }
      })
      .catch(function(e) {
        util.expectErrorToEqual(e, {
          name: 'OAuthError',
          message: 'something went wrong',
          errorCode: 'sampleErrorCode',
          errorSummary: 'something went wrong',
          tokenKey: 'test-accessToken',
          accessToken: true
        });
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });

    it('removes token if an AuthSdkError is thrown while renewing', function() {
      return oauthUtil.setupFrame({
        authClient: client,
        willFail: true,
        tokenManagerAddKeys: {
          'test-accessToken': tokens.standardAccessTokenParsed,
          'test-idToken': tokens.standardIdTokenParsed
        },
        tokenManagerRenewArgs: ['test-accessToken'],
        postMessageSrc: {
          baseUri: 'http://obviously.fake.foo',
        },
        postMessageResp: {
          state: oauthUtil.mockedState
        }
      })
      .catch(function(e) {
        util.expectErrorToEqual(e, {
          name: 'AuthSdkError',
          message: 'The request does not match client configuration',
          errorCode: 'INTERNAL',
          errorSummary: 'The request does not match client configuration',
          errorLink: 'INTERNAL',
          errorId: 'INTERNAL',
          errorCauses: [],
          tokenKey: 'test-accessToken',
          accessToken: true
        });
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });
  });

  describe('autoRenew', function() {
    beforeEach(function() {
      jest.useFakeTimers();
    });
    afterEach(function() {
      jest.useRealTimers();
      client.tokenManager.clear(); // clear all timeouts
    });
    it('should register listener for "expired" event', function() {
      jest.spyOn(Emitter.prototype, 'on');
      setupSync();
      expect(Emitter.prototype.on).toHaveBeenCalledWith('expired', expect.any(Function));
    });

    it('automatically renews a token by default', function() {
      var expiresAt = tokens.standardIdTokenParsed.expiresAt;
      return oauthUtil.setupFrame({
        authClient: setupSync({
          tokenManager: {
            autoRenew: true
          }
        }),
        autoRenew: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: expiresAt + 1,
        tokenManagerAddKeys: {
          'test-idToken': {
            idToken: 'testInitialToken',
            claims: {'fake': 'claims'},
            expiresAt: expiresAt,
            scopes: ['openid', 'email']
          }
        },
        postMessageSrc: {
          baseUri: 'https://auth-js-test.okta.com/oauth2/v1/authorize',
          queryParams: {
            'client_id': 'NPSfOkH5eZrTy8PMDlvx',
            'redirect_uri': 'https://example.com/redirect',
            'response_type': 'id_token',
            'response_mode': 'okta_post_message',
            'state': oauthUtil.mockedState,
            'nonce': oauthUtil.mockedNonce,
            'scope': 'openid email',
            'prompt': 'none'
          }
        },
        postMessageResp: {
          'id_token': tokens.standardIdToken,
          state: oauthUtil.mockedState
        }
      })
      .then(function() {
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });

    it('automatically renews a token early when local clock offset is considered', function() {
      var expiresAt = tokens.standardIdTokenParsed.expiresAt;
      return oauthUtil.setupFrame({
        authClient: setupSync({
          // local clock offset: 10 seconds behind the server
          localClockOffset: 10000,
          tokenManager: {
            autoRenew: true
          }
        }),
        autoRenew: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: expiresAt - 10, // set local time to 10 seconds until expiration
        tokenManagerAddKeys: {
          'test-idToken': {
            idToken: 'testInitialToken',
            claims: {'fake': 'claims'},
            expiresAt: expiresAt,
            scopes: ['openid', 'email']
          }
        },
        postMessageSrc: {
          baseUri: 'https://auth-js-test.okta.com/oauth2/v1/authorize',
          queryParams: {
            'client_id': 'NPSfOkH5eZrTy8PMDlvx',
            'redirect_uri': 'https://example.com/redirect',
            'response_type': 'id_token',
            'response_mode': 'okta_post_message',
            'state': oauthUtil.mockedState,
            'nonce': oauthUtil.mockedNonce,
            'scope': 'openid email',
            'prompt': 'none'
          }
        },
        postMessageResp: {
          'id_token': tokens.standardIdToken,
          state: oauthUtil.mockedState
        }
      })
      .then(function() {
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });

    it('renews a token early when "expireEarlySeconds" option is considered', function() {
      var expiresAt = tokens.standardIdTokenParsed.expiresAt;
      return oauthUtil.setupFrame({
        authClient: setupSync({
          tokenManager: {
            autoRenew: true,
            expireEarlySeconds: 10
          }
        }),
        autoRenew: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: expiresAt - 10, // set local time to 10 seconds until expiration
        tokenManagerAddKeys: {
          'test-idToken': {
            idToken: 'testInitialToken',
            claims: {'fake': 'claims'},
            expiresAt: expiresAt,
            scopes: ['openid', 'email']
          }
        },
        postMessageSrc: {
          baseUri: 'https://auth-js-test.okta.com/oauth2/v1/authorize',
          queryParams: {
            'client_id': 'NPSfOkH5eZrTy8PMDlvx',
            'redirect_uri': 'https://example.com/redirect',
            'response_type': 'id_token',
            'response_mode': 'okta_post_message',
            'state': oauthUtil.mockedState,
            'nonce': oauthUtil.mockedNonce,
            'scope': 'openid email',
            'prompt': 'none'
          }
        },
        postMessageResp: {
          'id_token': tokens.standardIdToken,
          state: oauthUtil.mockedState
        }
      })
      .then(function() {
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });

    it('does not return the token after tokens were cleared before renew promise was resolved', function() {
      var expiresAt = tokens.standardIdTokenParsed.expiresAt;
      return oauthUtil.setupFrame({
        authClient: setupSync({
          tokenManager: {
            autoRenew: true
          }
        }),
        autoRenew: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: expiresAt + 1,
        tokenManagerAddKeys: {
          'test-idToken': {
            idToken: 'testInitialToken',
            claims: {'fake': 'claims'},
            expiresAt: expiresAt,
            scopes: ['openid', 'email']
          }
        },
        postMessageSrc: {
          baseUri: 'https://auth-js-test.okta.com/oauth2/v1/authorize',
          queryParams: {
            'client_id': 'NPSfOkH5eZrTy8PMDlvx',
            'redirect_uri': 'https://example.com/redirect',
            'response_type': 'id_token',
            'response_mode': 'okta_post_message',
            'state': oauthUtil.mockedState,
            'nonce': oauthUtil.mockedNonce,
            'scope': 'openid email',
            'prompt': 'none'
          }
        },
        postMessageResp: {
          'id_token': tokens.standardIdToken,
          state: oauthUtil.mockedState
        },
        beforeCompletion: function(authClient) {
          // Simulate tokens being cleared while the renew request is performed
          authClient.tokenManager.clear();
        }
      })
      .then(function() {
        oauthUtil.expectTokenStorageToEqual(localStorage, {});
      });
    });

    it('Emits an "error" event on OAuth failure', function(done) {
      setupSync({
        tokenManager: {
          autoRenew: true
        }
      });
      const error = {
        name: 'OAuthError',
        message: 'something went wrong',
        errorCode: 'sampleErrorCode',
        errorSummary: 'something went wrong',
        tokenKey: 'test-idToken',
        accessToken: false
      };
      var errorEventCallback = jest.fn().mockImplementation(function(err) {
        try {
          util.expectErrorToEqual(err, error);
        } catch (e) {
          done.fail(e);
        }
      });
      client.tokenManager.on('error', errorEventCallback);

      oauthUtil.setupFrame({
        authClient: client,
        autoRenew: true,
        willFail: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: tokens.standardIdTokenParsed.expiresAt + 1,
        tokenManagerAddKeys: {
          'test-idToken': tokens.standardIdTokenParsed
        },
        postMessageResp: {
          error: 'sampleErrorCode',
          'error_description': 'something went wrong',
          state: oauthUtil.mockedState
        }
      })
      .catch(function(err) {
        util.expectErrorToEqual(err, error);
        oauthUtil.expectTokenStorageToEqual(localStorage, {});
        expect(errorEventCallback).toHaveBeenCalled();
      })
      .then(function() {
        done();
      })
      .catch(function(err) {
        done.fail(err);
      });
    });

    it('Emits an "error" event on AuthSdkError', function(done) {
      setupSync({
        tokenManager: {
          autoRenew: true
        }
      });
      var errorEventCallback = jest.fn().mockImplementation(function(err) {
        try {
          util.expectErrorToEqual(err, {
            name: 'AuthSdkError',
            message: 'The request does not match client configuration',
            errorCode: 'INTERNAL',
            errorSummary: 'The request does not match client configuration',
            errorLink: 'INTERNAL',
            errorId: 'INTERNAL',
            errorCauses: [],
            tokenKey: 'test-idToken',
            accessToken: false
          });
        } catch (e) {
          done.fail(e);
        }
      });
      client.tokenManager.on('error', errorEventCallback);

      oauthUtil.setupFrame({
        authClient: client,
        autoRenew: true,
        willFail: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: tokens.standardIdTokenParsed.expiresAt + 1,
        tokenManagerAddKeys: {
          'test-idToken': tokens.standardIdTokenParsed
        },
        postMessageSrc: {
          baseUri: 'http://obviously.fake.foo',
        },
        postMessageResp: {
          state: oauthUtil.mockedState
        }
      })
      .catch(function(err) {
        util.expectErrorToEqual(err, {
          name: 'AuthSdkError',
          message: 'The request does not match client configuration',
          errorCode: 'INTERNAL',
          errorSummary: 'The request does not match client configuration',
          errorLink: 'INTERNAL',
          errorId: 'INTERNAL',
          errorCauses: [],
          tokenKey: 'test-idToken',
          accessToken: false
        });
        oauthUtil.expectTokenStorageToEqual(localStorage, {});

        expect(errorEventCallback).toHaveBeenCalled();
      })
      .then(function() {
        done();
      })
      .catch(function(err) {
        done.fail(err);
      });
    });

    it('removes a token on OAuth failure', function() {
      return oauthUtil.setupFrame({
        authClient: setupSync({
          tokenManager: {
            autoRenew: true
          }
        }),
        autoRenew: true,
        willFail: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: tokens.standardIdTokenParsed.expiresAt + 1,
        tokenManagerAddKeys: {
          'test-idToken': tokens.standardIdTokenParsed
        },
        postMessageResp: {
          error: 'sampleErrorCode',
          'error_description': 'something went wrong',
          state: oauthUtil.mockedState
        }
      })
      .catch(function(err) {
        util.expectErrorToEqual(err, {
          name: 'OAuthError',
          message: 'something went wrong',
          errorCode: 'sampleErrorCode',
          errorSummary: 'something went wrong',
          tokenKey: 'test-idToken',
          accessToken: false
        });
        oauthUtil.expectTokenStorageToEqual(localStorage, {});
      });
    });

    it('removes a token on AuthSdkError', function() {
      return oauthUtil.setupFrame({
        authClient: setupSync({
          tokenManager: {
            autoRenew: true
          }
        }),
        autoRenew: true,
        willFail: true,
        fastForwardToTime: true,
        autoRenewTokenKey: 'test-idToken',
        time: tokens.standardIdTokenParsed.expiresAt + 1,
        tokenManagerAddKeys: {
          'test-idToken': tokens.standardIdTokenParsed
        },
        postMessageSrc: {
          baseUri: 'http://obviously.fake.foo',
        },
        postMessageResp: {
          state: oauthUtil.mockedState
        }
      })
      .catch(function(e) {
        util.expectErrorToEqual(e, {
          name: 'AuthSdkError',
          message: 'The request does not match client configuration',
          errorCode: 'INTERNAL',
          errorSummary: 'The request does not match client configuration',
          errorLink: 'INTERNAL',
          errorId: 'INTERNAL',
          errorCauses: [],
          tokenKey: 'test-idToken',
          accessToken: false
        });
        oauthUtil.expectTokenStorageToEqual(localStorage, {});
      });
    });

    it('emits "expired" on existing tokens even when autoRenew is disabled', function() {
      jest.useFakeTimers();
      localStorage.setItem('okta-token-storage', JSON.stringify({
        'test-idToken': tokens.standardIdTokenParsed
      }));
      setupSync({ tokenManager: { autoRenew: false } });
      util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
      var callback = jest.fn();
      client.tokenManager.on('expired', callback);
      util.warpByTicksToUnixTime(tokens.standardIdTokenParsed.expiresAt + 1);
      expect(callback).toHaveBeenCalledWith('test-idToken', tokens.standardIdTokenParsed);
    });

    it('emits "expired" on new tokens even when autoRenew is disabled', function() {
      jest.useFakeTimers();
      setupSync({ tokenManager: { autoRenew: false } });
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
      var callback = jest.fn();
      client.tokenManager.on('expired', callback);
      util.warpByTicksToUnixTime(tokens.standardIdTokenParsed.expiresAt + 1);
      expect(callback).toHaveBeenCalledWith('test-idToken', tokens.standardIdTokenParsed);
    });

    it('accounts for local clock offset when emitting "expired"', function() {
      util.warpToUnixTime(tokens.standardIdTokenClaims.exp);
      var localClockOffset = -2000; // local client is 2 seconds fast
      setupSync({
        localClockOffset: localClockOffset
      });
      var callback = jest.fn();
      client.tokenManager.on('expired', callback);
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      jest.advanceTimersByTime(0);
      expect(callback).not.toHaveBeenCalled();
      jest.advanceTimersByTime(-localClockOffset);
      expect(callback).toHaveBeenCalledWith('test-idToken', tokens.standardIdTokenParsed);
    });
  
    it('accounts for "expireEarlySeconds" option when emitting "expired"', function() {
      var expireEarlySeconds = 10;
      util.warpToUnixTime(tokens.standardIdTokenClaims.exp - (expireEarlySeconds + 1));
      setupSync({
        tokenManager: {
          expireEarlySeconds: expireEarlySeconds
        }
      });
      var callback = jest.fn();
      client.tokenManager.on('expired', callback);
      client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
      jest.advanceTimersByTime(0);
      expect(callback).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledWith('test-idToken', tokens.standardIdTokenParsed);
    });

    describe('too many renew requests', () => {
      it('should emit too many renew error when latest 10 expired event happen in 30 seconds', () => {
        setupSync({
          tokenManager: { autoRenew: true }
        });
        client.tokenManager.renew = jest.fn().mockImplementation(() => Promise.resolve());
        const handler = jest.fn().mockImplementation(err => {
          util.expectErrorToEqual(err, {
            name: 'AuthSdkError',
            message: 'Too many token renew requests',
            errorCode: 'INTERNAL',
            errorSummary: 'Too many token renew requests',
            errorLink: 'INTERNAL',
            errorId: 'INTERNAL',
            errorCauses: []
          });
        });
        client.tokenManager.on('error', handler);
        let startTime = Math.round(Date.now() / 1000);
        // 2 * 10 < 30 => emit error
        for (let i = 0; i < 10; i++) {
          util.warpToUnixTime(startTime);
          client.emitter.emit('expired');
          startTime = startTime + 2;
        }
        expect(handler).toHaveBeenCalledTimes(1);
        expect(client.tokenManager.renew).toHaveBeenCalledTimes(9);
      });

      it('should keep emitting errors if expired events keep emitting in 30s', () => {
        setupSync({
          tokenManager: { autoRenew: true }
        });
        client.tokenManager.renew = jest.fn().mockImplementation(() => Promise.resolve());
        const handler = jest.fn();
        client.tokenManager.on('error', handler);
        let startTime = Math.round(Date.now() / 1000);
        // 2 * 10 < 30 => emit error
        for (let i = 0; i < 20; i++) {
          util.warpToUnixTime(startTime);
          client.emitter.emit('expired');
          startTime = startTime + 2;
        }
        expect(handler).toHaveBeenCalledTimes(11);
        expect(client.tokenManager.renew).toHaveBeenCalledTimes(9);
      });
  
      it('should not emit error if time diff for the latest 10 requests are more than 30s', () => {
        setupSync({
          tokenManager: { autoRenew: true }
        });
        const handler = jest.fn();
        client.tokenManager.on('error', handler);
        client.tokenManager.renew = jest.fn().mockImplementation(() => Promise.resolve());
        let startTime = Math.round(Date.now() / 1000);
        // 5 * 10 > 30 => not emit error
        for (let i = 0; i < 20; i++) {
          util.warpToUnixTime(startTime);
          client.emitter.emit('expired');
          startTime = startTime + 5;
        }
        expect(handler).not.toHaveBeenCalled();
        expect(client.tokenManager.renew).toHaveBeenCalledTimes(20);
      });

      it('should resume autoRenew if requests become normal again', () => {
        setupSync({
          tokenManager: { autoRenew: true }
        });
        const handler = jest.fn();
        client.tokenManager.on('error', handler);
        client.tokenManager.renew = jest.fn().mockImplementation(() => Promise.resolve());

        // trigger too many requests error
        // 10 * 2 < 30 => should emit error
        let startTime = Math.round(Date.now() / 1000);
        for (let i = 0; i < 20; i++) {
          util.warpToUnixTime(startTime);
          client.emitter.emit('expired');
          startTime = startTime + 2;
        }
        // resume to normal requests
        // wait 50s, then 10 * 5 > 30 => not emit error
        startTime = startTime + 50;
        util.warpToUnixTime(startTime);
        for (let i = 0; i < 10; i++) {
          util.warpToUnixTime(startTime);
          client.emitter.emit('expired');
          startTime = startTime + 5;
        }

        expect(handler).toHaveBeenCalledTimes(11);
        expect(client.tokenManager.renew).toHaveBeenCalledTimes(19);
      });
    });
  });

  describe('localStorage', function() {

    beforeEach(() => {
      setupSync({
        tokenManager: {
          storage: 'localStorage'
        }
      });
    });

    describe('add', function() {
      it('adds a token', function() {
        client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });

    describe('get', function() {
      it('returns a token', function() {
        localStorage.setItem('okta-token-storage', JSON.stringify({
          'test-idToken': tokens.standardIdTokenParsed
        }));
        util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
        return client.tokenManager.get('test-idToken')
        .then(function(token) {
          expect(token).toEqual(tokens.standardIdTokenParsed);
        });
      });
    });

    describe('remove', function() {
      it('removes a token', function() {
        localStorage.setItem('okta-token-storage', JSON.stringify({
          'test-idToken': tokens.standardIdTokenParsed,
          anotherKey: tokens.standardIdTokenParsed
        }));
        client.tokenManager.remove('test-idToken');
        oauthUtil.expectTokenStorageToEqual(localStorage, {
          anotherKey: tokens.standardIdTokenParsed
        });
      });
    });

    describe('clear', function() {
      it('clears all tokens', function() {
        localStorage.setItem('okta-token-storage', JSON.stringify({
          'test-idToken': tokens.standardIdTokenParsed,
          anotherKey: tokens.standardIdTokenParsed
        }));
        client.tokenManager.clear();
        oauthUtil.expectTokenStorageToEqual(localStorage, {});
      });
    });
  });

  describe('sessionStorage', function() {

    beforeEach(() => {
      setupSync({
        tokenManager: {
          storage: 'sessionStorage'
        }
      });
    });

    describe('add', function() {
      it('adds a token', function() {
        client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
        oauthUtil.expectTokenStorageToEqual(sessionStorage, {
          'test-idToken': tokens.standardIdTokenParsed
        });
      });
    });

    describe('get', function() {
      it('returns a token', function() {
        sessionStorage.setItem('okta-token-storage', JSON.stringify({
          'test-idToken': tokens.standardIdTokenParsed
        }));
        util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
        return client.tokenManager.get('test-idToken')
        .then(function(token) {
          expect(token).toEqual(tokens.standardIdTokenParsed);
        });
      });
    });

    describe('remove', function() {
      it('removes a token', function() {
        sessionStorage.setItem('okta-token-storage', JSON.stringify({
          'test-idToken': tokens.standardIdTokenParsed,
          anotherKey: tokens.standardIdTokenParsed
        }));
        client.tokenManager.remove('test-idToken');
        oauthUtil.expectTokenStorageToEqual(sessionStorage, {
          anotherKey: tokens.standardIdTokenParsed
        });
      });
    });

    describe('clear', function() {
      it('clears all tokens', function() {
        sessionStorage.setItem('okta-token-storage', JSON.stringify({
          'test-idToken': tokens.standardIdTokenParsed,
          anotherKey: tokens.standardIdTokenParsed
        }));
        client.tokenManager.clear();
        oauthUtil.expectTokenStorageToEqual(sessionStorage, {});
      });
    });
  });

  describe('cookie', function() {

    function cookieStorageSetup() {
      setupSync({
        tokenManager: {
          storage: 'cookie'
        }
      });
    }

    describe('add', function() {
      it('adds a token', function() {
        cookieStorageSetup();
        var setCookieMock = util.mockSetCookie();
        client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
        expect(setCookieMock).toHaveBeenCalledWith(
          'okta-token-storage_test-idToken',
          JSON.stringify(tokens.standardIdTokenParsed),
          '2200-01-01T00:00:00.000Z',
          secureCookieSettings
        );
      });

    });

    describe('get', function() {
      it('returns a token', function() {
        const setCookieMock = util.mockSetCookie();
        const getCookieMock = util.mockGetCookie({
          'okta-token-storage_test-idToken': JSON.stringify(tokens.standardIdTokenParsed)
        });
        cookieStorageSetup();
        util.warpToUnixTime(tokens.standardIdTokenClaims.iat); // token should not be expired
        return client.tokenManager.get('test-idToken')
        .then(function(token) {
          expect(token).toEqual(tokens.standardIdTokenParsed);
          expect(getCookieMock).toHaveBeenCalledWith();
          expect(setCookieMock).not.toHaveBeenCalled();
        });
      });

      it('returns undefined for an expired token', function() {
        const setCookieMock = util.mockSetCookie();
        const getCookieMock = util.mockGetCookie(JSON.stringify({
          'test-idToken': tokens.standardIdTokenParsed
        }));
        cookieStorageSetup();
        util.warpToUnixTime(tokens.standardIdTokenClaims.exp + 1); // token should be expired
        client.tokenManager.add('test-idToken', tokens.standardIdTokenParsed);
        return client.tokenManager.get('test-idToken')
        .then(function(token) {
          expect(token).toBeUndefined();
          expect(getCookieMock).toHaveBeenCalledWith('okta-token-storage_test-idToken');
          expect(setCookieMock).toHaveBeenCalledWith(
            'okta-token-storage_test-idToken',
            JSON.stringify(tokens.standardIdTokenParsed),
            '2200-01-01T00:00:00.000Z', {
              secure: true,
              sameSite: 'none'
            }
          );
        });
      });
    });

    describe('remove', function() {
      it('removes a token', function() {
        util.mockGetCookie({
          'okta-token-storage_test-idToken': JSON.stringify(tokens.standardIdTokenParsed),
          'okta-token-storage_anotherKey': JSON.stringify(tokens.standardIdTokenParsed)
        });
        util.mockSetCookie({
          'okta-token-storage_anotherKey': JSON.stringify(tokens.standardIdTokenParsed)
        });
        cookieStorageSetup();
        const deleteCookieMock = util.mockDeleteCookie();
        client.tokenManager.remove('test-idToken');
        expect(deleteCookieMock).toHaveBeenCalledWith('okta-token-storage_test-idToken');
      });
    });

    describe('clear', function() {
      it('clears all tokens', function() {
        util.mockGetCookie({
          'okta-token-storage_test-idToken': JSON.stringify(tokens.standardIdTokenParsed),
          'okta-token-storage_anotherKey': JSON.stringify(tokens.standardIdTokenParsed)
        });
        cookieStorageSetup();
        const deleteCookieMock = util.mockDeleteCookie();
        client.tokenManager.clear();
        expect(deleteCookieMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('get', function() {
    it('should throw AuthSdkError if autoRenew is turned on and app is in oauth callback state', async () => {
      delete global.window.location;
      global.window.location = {
        protocol: 'https:',
        hostname: 'somesite.local',
        search: '?code=fakecode'
      };
      client = new OktaAuth({
        pkce: true,
        issuer: 'https://auth-js-test.okta.com',
        clientId: 'foo'
      });
  
      try {
        await client.tokenManager.get();
      } catch (err) {
        expect(err).toBeInstanceOf(AuthSdkError);
        expect(err.message).toBe('The app should not attempt to call authorize API on callback. Authorize flow is already in process. Use parseFromUrl() to receive tokens.');
      }
    });
  });

  describe('hasExpired', function() {

    it('returns false for a token that has not expired', function() {
      util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
      localStorage.setItem('okta-token-storage', JSON.stringify({
        'test-idToken': tokens.standardIdTokenParsed
      }));
      setupSync();
      return client.tokenManager.get('test-idToken')
      .then(function(token) {
        expect(token).toBeTruthy();
        expect(client.tokenManager.hasExpired(token)).toBe(false);
      });
    });

    it('returns false when a token is not expired, accounting for local clock offset', function() {
      util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
      localStorage.setItem('okta-token-storage', JSON.stringify({
        'test-idToken': tokens.standardIdTokenParsed
      }));
      setupSync({
        localClockOffset: -2000 // local clock is 2 seconds ahead of server
      });
      // Set local time to server expiration. local clock offset should keep the token valid
      util.warpToUnixTime(tokens.standardIdTokenParsed.expiresAt + 1);
      return client.tokenManager.get('test-idToken')
      .then(function(token) {
        expect(token).toBeTruthy();
        expect(client.tokenManager.hasExpired(token)).toBe(false);
      });
    });

    it('returns true for a token that has expired', function() {
      util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
      localStorage.setItem('okta-token-storage', JSON.stringify({
        'test-idToken': tokens.standardIdTokenParsed
      }));
      setupSync();
      util.warpToUnixTime(tokens.standardIdTokenParsed.expiresAt + 1);
      return client.tokenManager.get('test-idToken')
      .then(function(token) {
        expect(token).toBeTruthy();
        expect(client.tokenManager.hasExpired(token)).toBe(true);
      });
    });

    it('returns true when a token is expired, accounting for local clock offset', function() {
      util.warpToUnixTime(tokens.standardIdTokenClaims.iat);
      localStorage.setItem('okta-token-storage', JSON.stringify({
        'test-idToken': tokens.standardIdTokenParsed
      }));
      setupSync({
        localClockOffset: 5000 // local clock is 5 seconds behind server
      });
      // Set local time to server expiration minus 5 seconds
      util.warpToUnixTime(tokens.standardIdTokenParsed.expiresAt - 5);
      return client.tokenManager.get('test-idToken')
      .then(function(token) {
        expect(token).toBeTruthy();
        expect(client.tokenManager.hasExpired(token)).toBe(true);
      });
    });

  });
});


