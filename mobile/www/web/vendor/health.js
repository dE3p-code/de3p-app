var capacitorHealth = (function (exports, core) {
    'use strict';

    const Health = core.registerPlugin('Health', {
        web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.HealthWeb()),
    });

    class HealthWeb extends core.WebPlugin {
        async isAvailable() {
            return {
                available: false,
                platform: 'web',
                reason: 'Native health APIs are not accessible in a browser environment.',
            };
        }
        async requestAuthorization(_options) {
            throw this.unimplemented('Health permissions are only available on native platforms.');
        }
        async checkAuthorization(_options) {
            throw this.unimplemented('Health permissions are only available on native platforms.');
        }
        async readSamples(_options) {
            throw this.unimplemented('Reading health data is only available on native platforms.');
        }
        async saveSample(_options) {
            throw this.unimplemented('Writing health data is only available on native platforms.');
        }
        async getPluginVersion() {
            return { version: 'web' };
        }
        async openHealthConnectSettings() {
            // No-op on web - Health Connect is Android only
        }
        async showPrivacyPolicy() {
            // No-op on web - Health Connect privacy policy is Android only
        }
        async queryWorkouts(_options) {
            throw this.unimplemented('Querying workouts is only available on native platforms.');
        }
        async queryAggregated(_options) {
            throw this.unimplemented('Querying aggregated data is only available on native platforms.');
        }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        HealthWeb: HealthWeb
    });

    exports.Health = Health;

    return exports;

})({}, capacitorExports);
//# sourceMappingURL=plugin.js.map
