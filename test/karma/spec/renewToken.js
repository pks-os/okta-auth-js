/* global jasmine, window, document, URL, Event, Promise */
require('jasmine-ajax');

var tokens = require('../../util/tokens');

import OktaAuth from '@okta/okta-auth-js';
import oauthUtil from '../../../lib/oauthUtil';
import pkce from '../../../lib/pkce';
import OauthError from '../../../lib/errors/OAuthError';

describe('Renew token', function() {

  const ASSUMED_TIME = 1449699929;
  const ISSUER = tokens.standardIdTokenParsed.issuer;
  const CALLBACK_PATH = '/implicit/callback';
  const REDIRECT_URI = `${ISSUER}${CALLBACK_PATH}`;
  const CLIENT_ID = tokens.standardIdTokenParsed.clientId;
  const DEFAULT_CONFIG = {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
  };

  const ACCESS_TOKEN_STR = 'fakeytoken'; // will not be verified in this flow
  const ACCCESS_TOKEN_PARSED = tokens.standardAccessTokenParsed;
  const NONCE = tokens.standardIdTokenClaims.nonce;
  const AUTHORIZATION_CODE = 'FAKEY';
  const JWKS_URI = 'http://myfake.jwks.local';

  var sdk;


  beforeEach(function() {
    document.body.insertAdjacentHTML('beforeend', '<div id="root"></div>');
    var date = new Date();
    date.setTime(ASSUMED_TIME * 1000);
    jasmine.clock().mockDate(date);
    jasmine.Ajax.install();
  });

  afterEach(function() {
    document.body.removeChild(document.getElementById('root'));
    jasmine.clock().uninstall();
    jasmine.Ajax.uninstall();
  });

  function bootstrap(config) {
    config = Object.assign({}, DEFAULT_CONFIG, config);
    sdk = new OktaAuth(config);
    sdk.tokenManager.clear();
    return Promise.resolve();
  }

  function mockWellKnown() {
    sdk.options.storageUtil.getHttpCache().clearStorage();

    var wellKnown = {
      'jwks_uri': JWKS_URI,
      code_challenge_methods_supported: ['S256']
    };
    var keys = [
      tokens.standardKey
    ];
    jasmine.Ajax.stubRequest(
      /.*\.well-known/
    ).andReturn({
      status: 200,
      responseText: JSON.stringify(wellKnown)
    });

    jasmine.Ajax.stubRequest(
      JWKS_URI
    ).andReturn({
      status: 200,
      responseText: JSON.stringify({
        keys: keys
      })
    });
  }

  it('receives/throws error from iframe', function() {
    // This is the error if requesting scope='offline_access'
    const error = 'access_denied';
    const error_description = 'Policy evaluation succeeded but all the requested scopes were rejected.';

    return bootstrap()
    .then(() => {
      sdk.tokenManager.add('accessToken', ACCCESS_TOKEN_PARSED);

      // We are not loading a real iframe
      spyOn(oauthUtil, 'loadFrame').and.callFake(urlStr => {
        const url = new URL(urlStr);
        const state = url.searchParams.get('state');
        var response = {
          state,
          error,
          error_description,
          name: 'OAuthError'    
        };

        // Simulate window.postMessage() from iframe
        var event = new Event('message');
        event.data = response;
        event.origin = ISSUER;
        window.dispatchEvent(event);

      });
      return sdk.tokenManager.renew('accessToken');
    })
    .catch(e => {
      expect(oauthUtil.loadFrame).toHaveBeenCalled();
      expect(e instanceof OauthError).toBe(true);
      expect(e.message).toBe(error_description);
    });
  });

  it('grantType: implicit', function() {
    return bootstrap({
      grantType: 'implicit'
    })
    .then(() => {
      sdk.tokenManager.add('accessToken', ACCCESS_TOKEN_PARSED);

      // We are not loading a real iframe
      spyOn(oauthUtil, 'loadFrame').and.callFake(urlStr => {
        const url = new URL(urlStr);
        expect(url.origin).toBe(ISSUER);
        expect(url.pathname).toBe('/oauth2/v1/authorize');
        expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
        expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
        expect(url.searchParams.get('response_type')).toBe('token');
        expect(url.searchParams.get('response_mode')).toBe('okta_post_message');
        expect(url.searchParams.get('scope')).toBe('openid email');
        expect(url.searchParams.get('state')).toBeTruthy();
        
        // nonce will be a random string when renewing access token. Is this expected?
        // expect(url.searchParams.get('nonce')).toBe(NONCE);

        // Response back to caller
        const state = url.searchParams.get('state');
        const scope = url.searchParams.get('scope');
        var response = {
          access_token: ACCESS_TOKEN_STR,
          expires_in: 3600,
          scope,
          state,
          token_type: 'Bearer'
        };

        // Simulate window.postMessage() from iframe
        var event = new Event('message');
        event.data = response;
        event.origin = ISSUER;
        window.dispatchEvent(event);

      });
      return sdk.tokenManager.renew('accessToken');
    })
    .then(function(res) {
      expect(oauthUtil.loadFrame).toHaveBeenCalled();
      expect(res.accessToken).toBe(ACCESS_TOKEN_STR);
    });
  });

  it('grantType: authorization_code', function() {
    var codeChallenge, codeVerifier;

    return bootstrap({
      grantType: 'authorization_code'
    })
    .then(() => {
      sdk.tokenManager.add('accessToken', ACCCESS_TOKEN_PARSED);

      mockWellKnown();
  
      // We are not loading a real iframe
      spyOn(oauthUtil, 'loadFrame').and.callFake(urlStr => {
        const url = new URL(urlStr);
        expect(url.origin).toBe(ISSUER);
        expect(url.pathname).toBe('/oauth2/v1/authorize');
        expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
        expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('response_mode')).toBe('okta_post_message');
        expect(url.searchParams.get('scope')).toBe('openid email');
        expect(url.searchParams.get('state')).toBeTruthy();
        
        // nonce will be a random string when renewing access token. Is this expected?
        // expect(url.searchParams.get('nonce')).toBe(NONCE);

        const state = url.searchParams.get('state');
        codeChallenge = url.searchParams.get('code_challenge');
        expect(codeChallenge).toBeTruthy();

        // response from /authorize
        var authResponse = {
          code: AUTHORIZATION_CODE,
          state,
        };

        // response from /token
        const tokenResponse = {
          'access_token': ACCESS_TOKEN_STR,
          'nonce': NONCE,
          'expires_in': 1000
        };

        jasmine.Ajax.requests.reset();
        jasmine.Ajax.stubRequest(
          /.*v1\/token/
        ).andReturn({
          status: 200,
          responseText: JSON.stringify(tokenResponse)
        });

                
        // Simulate window.postMessage() from iframe
        var event = new Event('message');
        event.data = authResponse;
        event.origin = ISSUER;
        window.dispatchEvent(event);

      });
      return sdk.tokenManager.renew('accessToken');
    })
    .then(res => {
      expect(oauthUtil.loadFrame).toHaveBeenCalled();
      expect(res.accessToken).toBe(ACCESS_TOKEN_STR);

      // Validate POST request to /token
      var request = jasmine.Ajax.requests.first();
      expect(request.url).toBe(`${ISSUER}/oauth2/v1/token`);
      expect(request.method).toBe('POST');
      expect(request.requestHeaders['content-type']).toBe('application/x-www-form-urlencoded');
      expect(request.withCredentials).toBe(false);

      // Decode request params
      var params = {};
      request.params.split('&').forEach(function(str) {
        var pair = str.split('=');
        params[pair[0]] = decodeURIComponent(pair[1]);
      });
      expect(params['client_id']).toBe(CLIENT_ID);
      expect(params['redirect_uri']).toBe(REDIRECT_URI);
      expect(params['grant_type']).toBe('authorization_code');
      expect(params['code']).toBe(AUTHORIZATION_CODE);
      expect(params['code_verifier']).toBeTruthy();

      codeVerifier = params['code_verifier'];
      return pkce.computeChallenge(codeVerifier);
    }).then(computed => {
      expect(computed).toBe(codeChallenge);
    });
  });

});
