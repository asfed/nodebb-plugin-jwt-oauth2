(function(module) {
    "use strict";

    /*
    	Welcome to the SSO OAuth plugin! If you're inspecting this code, you're probably looking to
    	hook up NodeBB with your existing OAuth endpoint.

    	Step 1: Fill in the "constants" section below with the requisite informaton. Either the "oauth"
    			or "oauth2" section needs to be filled, depending on what you set "type" to.

    	Step 2: Give it a whirl. If you see the congrats message, you're doing well so far!

    	Step 3: Customise the `parseUserReturn` method to normalise your user route's data return into
    			a format accepted by NodeBB. Instructions are provided there. (Line 146)

    	Step 4: If all goes well, you'll be able to login/register via your OAuth endpoint credentials.
    	*/

    var User = require.main.require('./src/user'),
        Groups = require.main.require('./src/groups'),
        meta = require.main.require('./src/meta'),
        db = require.main.require('./src/database'),
        passport = module.parent.require('passport'),
        fs = module.parent.require('fs'),
        path = module.parent.require('path'),
        nconf = module.parent.require('nconf'),
        winston = module.parent.require('winston'),
        ssoConfig = require.main.require('./sso-config'),
        async = module.parent.require('async');

    var authenticationController = require.main.require('./src/controllers/authentication');

    var constants = Object.freeze(ssoConfig.constants);
    var configOk = false;
    var OAuth = {};
    var passportOAuth;
    var opts;

    if (!constants.name) {
        winston.error('[sso-oauth] Please specify a name for your OAuth provider (library.js:32)');
    } else if (!constants.type || (constants.type !== 'oauth' && constants.type !== 'oauth2')) {
        winston.error('[sso-oauth] Please specify an OAuth strategy to utilise (library.js:31)');
    } else if (!constants.userRoute) {
        winston.error('[sso-oauth] User Route required (library.js:31)');
    } else {
        configOk = true;
    }

    OAuth.getStrategy = function(strategies, callback) {
        if (configOk) {
            passportOAuth = require('passport-oauth')[constants.type === 'oauth' ? 'OAuthStrategy' : 'OAuth2Strategy'];

            if (constants.type === 'oauth') {
                // OAuth options
                opts = constants.oauth;
                opts.callbackURL = nconf.get('url') + '/auth/' + constants.name + '/callback';

                passportOAuth.Strategy.prototype.userProfile = function(token, secret, params, done) {
                    this._oauth.get(constants.userRoute, token, secret, function(err, body, res) {
                        if (err) {
                            return done(new InternalOAuthError('failed to fetch user profile', err));
                        }

                        try {
                            var json = JSON.parse(body);
                            OAuth.parseUserReturn(json, function(err, profile) {
                                if (err) return done(err);
                                profile.provider = constants.name;

                                done(null, profile);
                            });
                        } catch (e) {
                            done(e);
                        }
                    });
                };
            } else if (constants.type === 'oauth2') {
                // OAuth 2 options
                opts = constants.oauth2;
                opts.callbackURL = nconf.get('url') + '/auth/' + constants.name + '/callback';

                passportOAuth.Strategy.prototype.userProfile = function(accessToken, done) {
                    //const uid = OAuth.getUidFromToken(accessToken);
                    //this._oauth2.get(constants.userRoute + uid, accessToken, function(err, body, res) {
                    this._oauth2.get(constants.userRoute, accessToken, function(err, body, res) {
                        if (err) {
                            return done(new InternalOAuthError('failed to fetch user profile', err));
                        }

                        try {
                            var json = JSON.parse(body);
                            OAuth.parseUserReturn(json, function(err, profile) {
                                if (err) return done(err);
                                profile.provider = constants.name;
                                
                                done(null, profile);
                            });
                        } catch (e) {
                            done(e);
                        }
                    });
                };
            }

            opts.passReqToCallback = true;

            passport.use(constants.name, new passportOAuth(opts, function(req, token, secret, profile, done) {
                OAuth.login({
                    oAuthid: profile.id,
                    handle: profile.displayName,
                    email: profile.emails[0].value,
                    isAdmin: profile.isAdmin,
                    token: token,
                }, function(err, user) {
                    if (err) {
                        return done(err);
                    }

                    authenticationController.onSuccessfulLogin(req, user.uid);
                    done(null, user);
                });
            }));

            strategies.push({
                name: constants.name,
                url: '/auth/' + constants.name,
                callbackURL: '/auth/' + constants.name + '/callback',
                icon: constants.icon,
                scope: (constants.scope || '').split(',')
            });

            callback(null, strategies);
        } else {
            callback(new Error('OAuth Configuration is invalid'));
        }
    };

    OAuth.parseUserReturn = function(data, callback) {
        // Alter this section to include whatever data is necessary
        // NodeBB *requires* the following: id, displayName, emails.
        // Everything else is optional.

        // Find out what is available by uncommenting this line:
        //console.log(data);

        var profileKeys = Object.keys(ssoConfig.profile);
        var profile = profileKeys.reduce(function(acc, key, i) {
            var keyValue = ssoConfig.profile[key];

            if (key === 'emails') {
                acc[key] = [{
                    value: data[keyValue]
                }];
                return acc;
            }

            acc[key] = data[keyValue];
            return acc;
        }, {});


        // Do you want to automatically make somebody an admin? This line might help you do that...
        profile.isAdmin = false;

        // Delete or comment out the next TWO (2) lines when you are ready to proceed
        // process.stdout.write('===\nAt this point, you\'ll need to customise the above section to id, displayName, and emails into the "profile" object.\n===');
        // return callback(new Error('Congrats! So far so good -- please see server log for details'));
        
        callback(null, profile);
    }

    OAuth.login = function(payload, callback) {

        OAuth.getUidByOAuthid(payload.oAuthid, function(err, uid) {
            if (err) {
                return callback(err);
            }

            if (uid !== null) {
                // Existing User
                callback(null, {
                    uid: uid
                });
            } else {
                // New User
                var success = function(uid) {
                    // Save provider-specific information to the user
                    User.setUserField(uid, constants.name + 'Id', payload.oAuthid);
                    db.setObjectField(constants.name + 'Id:uid', payload.oAuthid, uid);

                    if (payload.isAdmin) {
                        Groups.join('administrators', uid, function(err) {
                            callback(null, {
                                uid: uid
                            });
                        });
                    } else {
                        callback(null, {
                            uid: uid
                        });
                    }
                };

                User.getUidByEmail(payload.email, function(err, uid) {
                    if (err) {
                        return callback(err);
                    }

                    if (!uid) {
                        User.create({
                            username: payload.handle,
                            email: payload.email
                        }, function(err, uid) {
                            if (err) {
                                return callback(err);
                            }

                            success(uid);
                        });
                    } else {
                        success(uid); // Existing account -- merge
                    }
                });
            }
        });
    };

    OAuth.getUidByOAuthid = function(oAuthid, callback) {
        db.getObjectField(constants.name + 'Id:uid', oAuthid, function(err, uid) {
            if (err) {
                return callback(err);
            }
            callback(null, uid);
        });
    };

    OAuth.getUidFromToken = function(token) {
        //not working
        const parts = token.split('.');
        const buffer = Buffer.from(parts[1], 'base64');
        const data = JSON.parse(buffer);
        return data[ssoConfig.tokenIdField];
    }

    OAuth.deleteUserData = function(data, callback) {
        async.waterfall([
            async.apply(User.getUserField, data.uid, constants.name + 'Id'),
                function(oAuthIdToDelete, next) {
                    db.deleteObjectField(constants.name + 'Id:uid', oAuthIdToDelete, next);
                }
        ], function(err) {
            if (err) {
                winston.error('[sso-oauth] Could not remove OAuthId data for uid ' + data.uid + '. Error: ' + err);
                return callback(err);
            }

            callback(null, data);
        });
    };

    OAuth.init = function(data, callback) {
        var loginUrl = ssoConfig.loginUrl;
        var registerUrl = ssoConfig.registerUrl;
        loginUrl && data.router.get('/login', function(req, res) {
            res.redirect(loginUrl);
        });
        registerUrl && data.router.get('/register', function(req, res) {
            res.redirect(registerUrl);
        });
        callback(null, data);
    };

    module.exports = OAuth;
}(module));
