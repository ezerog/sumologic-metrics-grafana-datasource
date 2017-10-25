///<reference path="../node_modules/grafana-sdk-mocks/app/headers/common.d.ts" />
System.register(['lodash', 'moment'], function(exports_1) {
    var lodash_1, moment_1;
    var durationSplitRegexp, SumoLogicMetricsDatasource;
    return {
        setters:[
            function (lodash_1_1) {
                lodash_1 = lodash_1_1;
            },
            function (moment_1_1) {
                moment_1 = moment_1_1;
            }],
        execute: function() {
            durationSplitRegexp = /(\d+)(ms|s|m|h|d|w|M|y)/;
            // Things we still need to do:
            // - Fully understand the code; it looks like there are still leftovers
            //   from the Prometheus data source plugin in this code.
            // - Decide on the final "DSL" for template variable queries in
            //   metricFindQuery() and see if the autocomplete endpoint can do this
            //   more efficiently.
            // - start/end really shouldn't be instance fields on the data source
            //   object but it is not clear how else to have a time range handy
            //   for performSuggestQuery.
            // - quantizationDefined is wonky and shouldn't be an instance field
            //   either.
            // - How to support alerting?
            // - How to support annotations?
            /** @ngInject */
            SumoLogicMetricsDatasource = (function () {
                /** @ngInject */
                function SumoLogicMetricsDatasource(instanceSettings, backendSrv, templateSrv, $q) {
                    this.backendSrv = backendSrv;
                    this.templateSrv = templateSrv;
                    this.$q = $q;
                    this.url = instanceSettings.url;
                    this.basicAuth = instanceSettings.basicAuth;
                    console.log("sumo-logic-metrics-datasource - Datasource created.");
                }
                // Main API.
                // Called by Grafana to, well, test a datasource. Invoked
                // during Save & Test on a Datasource editor screen.
                SumoLogicMetricsDatasource.prototype.testDatasource = function () {
                    return this.metricFindQuery('metrics|*').then(function () {
                        return { status: 'success', message: 'Data source is working', title: 'Success' };
                    });
                };
                // Called by Grafana to find values for template variables.
                SumoLogicMetricsDatasource.prototype.metricFindQuery = function (query) {
                    // Bail out immediately if the caller didn't specify a query.
                    if (!query) {
                        return this.$q.when([]);
                    }
                    // With the help of templateSrv, we are going to first of all figure
                    // out the current values of all template variables.
                    var templateVariables = {};
                    lodash_1.default.forEach(lodash_1.default.clone(this.templateSrv.variables), function (variable) {
                        var name = variable.name;
                        var value = variable.current.value;
                        // Prepare the an object for this template variable in the map
                        // following the same structure as options.scopedVars from
                        // this.query() so we can then in the next step simply pass
                        // on the map to templateSrv.replace().
                        templateVariables[name] = { 'selelected': true, 'text': value, 'value': value };
                    });
                    // Resolve template variables in the query to their current value.
                    var interpolated;
                    try {
                        interpolated = this.templateSrv.replace(query, templateVariables);
                    }
                    catch (err) {
                        return this.$q.reject(err);
                    }
                    // The catalog query API returns many duplicate results and this
                    // could be a problem. Maybe figure out how to do the same thing
                    // with the autocomplete API?
                    if (interpolated.startsWith("metaTags|")) {
                        var split = interpolated.split("|");
                        var parameter = split[1];
                        var actualQuery = split[2];
                        var url = '/api/v1/metrics/meta/catalog/query';
                        var data = '{"query":"' + actualQuery + '", "offset":0, "limit":100000}';
                        return this._sumoLogicRequest('POST', url, data)
                            .then(function (result) {
                            var metaTagValues = lodash_1.default.map(result.data.results, function (resultEntry) {
                                var metaTags = resultEntry.metaTags;
                                var metaTagCount = metaTags.length;
                                var metaTag = null;
                                for (var metaTagIndex = 0; metaTagIndex < metaTagCount; metaTagIndex++) {
                                    metaTag = metaTags[metaTagIndex];
                                    if (metaTag.key === parameter) {
                                        break;
                                    }
                                }
                                return {
                                    text: metaTag.value,
                                    expandable: true
                                };
                            });
                            return lodash_1.default.uniqBy(metaTagValues, 'text');
                        });
                    }
                    else if (interpolated.startsWith("metrics|")) {
                        var split = interpolated.split("|");
                        var actualQuery = split[1];
                        var url = '/api/v1/metrics/meta/catalog/query';
                        var data = '{"query":"' + actualQuery + '", "offset":0, "limit":100000}';
                        return this._sumoLogicRequest('POST', url, data)
                            .then(function (result) {
                            var metricNames = lodash_1.default.map(result.data.results, function (resultEntry) {
                                var name = resultEntry.name;
                                return {
                                    text: name,
                                    expandable: true
                                };
                            });
                            return lodash_1.default.uniqBy(metricNames, 'text');
                        });
                    }
                    else if (interpolated.startsWith("x-tokens|")) {
                        var split = interpolated.split("|");
                        var actualQuery = split[1];
                        var url = '/api/v1/metrics/suggest/autocomplete';
                        var data = '{"queryId":"1","query":"' + actualQuery + '","pos":0,"apiVersion":"0.2.0",' +
                            '"requestedSectionsAndCounts":{"tokens":1000}}';
                        return this._sumoLogicRequest('POST', url, data)
                            .then(function (result) {
                            return lodash_1.default.map(result.data.suggestions[0].items, function (suggestion) {
                                return {
                                    text: suggestion.display,
                                };
                            });
                        });
                    }
                    // Unknown query type - error.
                    return this.$q.reject("Unknown metric find query: " + query);
                };
                // Called by Grafana to execute a metrics query.
                SumoLogicMetricsDatasource.prototype.query = function (options) {
                    var _this = this;
                    var self = this;
                    // Get the start and end time for the query. Remember the values so
                    // we can reuse them during performSuggestQuery, where we will also
                    // need a time range.
                    this.start = options.range.from.valueOf();
                    this.end = options.range.to.valueOf();
                    // This gives us the upper limit of data points to be returned
                    // by the Sumo backend and seems to be based on the width in
                    // pixels of the panel.
                    var maxDataPoints = options.maxDataPoints;
                    // Empirically, it seems that we get better looking graphs
                    // when requesting some fraction of the indicated width...
                    var requestedDataPoints = Math.round(maxDataPoints / 6);
                    // Figure out the desired quantization.
                    var desiredQuantization = this.calculateInterval(options.interval);
                    var targets = options.targets;
                    var queries = [];
                    lodash_1.default.each(options.targets, function (target) {
                        if (!target.expr || target.hide) {
                            return;
                        }
                        // Reset previous errors, if any.
                        target.error = null;
                        var query = {};
                        query.expr = _this.templateSrv.replace(target.expr, options.scopedVars);
                        query.requestId = options.panelId + target.refId;
                        queries.push(query);
                    });
                    // If there's no valid targets, return the empty result to
                    // save a round trip.
                    if (lodash_1.default.isEmpty(queries)) {
                        var d = this.$q.defer();
                        d.resolve({ data: [] });
                        return d.promise;
                    }
                    // Set up the promises.
                    var queriesPromise = [
                        this.doMetricsQuery(queries, this.start, this.end, maxDataPoints, requestedDataPoints, desiredQuantization)];
                    // Execute the queries and collect all the results.
                    return this.$q.all(queriesPromise).then(function (responses) {
                        var result = [];
                        for (var i = 0; i < responses.length; i++) {
                            var response = responses[i];
                            if (response.status === 'error') {
                                throw response.error;
                            }
                            var target = targets[i];
                            result = self.transformMetricData(targets, response.data.response);
                        }
                        // Return the results.
                        return { data: result };
                    });
                };
                // Helper methods.
                // Called from SumoLogicMetricsQueryCtrl.
                SumoLogicMetricsDatasource.prototype.performSuggestQuery = function (query) {
                    var url = '/api/v1/metrics/suggest/autocomplete';
                    var data = {
                        query: query,
                        pos: query.length,
                        queryStartTime: this.start,
                        queryEndTime: this.end
                    };
                    return this._sumoLogicRequest('POST', url, data).then(function (result) {
                        var suggestionsList = [];
                        lodash_1.default.each(result.data.suggestions, function (suggestion) {
                            lodash_1.default.each(suggestion.items, function (item) {
                                suggestionsList.push(item.replacement.text);
                            });
                        });
                        return suggestionsList;
                    });
                };
                // Transform results from the Sumo Logic Metrics API called in
                // query() into the format Grafana expects.
                SumoLogicMetricsDatasource.prototype.transformMetricData = function (targets, responses) {
                    var seriesList = [];
                    var errors = [];
                    for (var i = 0; i < responses.length; i++) {
                        var response = responses[i];
                        var target = targets[i];
                        if (!response.messageType) {
                            for (var j = 0; j < response.results.length; j++) {
                                var result = response.results[j];
                                // Synthesize the "target" - the "metric name" basically.
                                var target_1 = "";
                                var dimensions = result.metric.dimensions;
                                var firstAdded = false;
                                for (var k = 0; k < dimensions.length; k++) {
                                    var dimension = dimensions[k];
                                    if (dimension.legend === true) {
                                        if (firstAdded) {
                                            target_1 += ",";
                                        }
                                        target_1 += dimension.key + "=" + dimension.value;
                                        firstAdded = true;
                                    }
                                }
                                // Create Grafana-suitable datapoints.
                                var values = result.datapoints.value;
                                var timestamps = result.datapoints.timestamp;
                                var length_1 = Math.min(values.length, timestamps.length);
                                var datapoints = [];
                                for (var l = 0; l < length_1; l++) {
                                    var value = values[l];
                                    var valueParsed = parseFloat(value);
                                    var timestamp = timestamps[l];
                                    var timestampParsed = parseFloat(timestamp);
                                    datapoints.push([valueParsed, timestampParsed]);
                                }
                                // Add the series.
                                seriesList.push({ target: target_1, datapoints: datapoints });
                            }
                        }
                        else {
                            console.log("sumo-logic-metrics-datasource - Datasource.transformMetricData - error: " +
                                JSON.stringify(response));
                            errors.push(response.message);
                            target.error = response.message;
                        }
                    }
                    if (errors.length > 0) {
                        throw { message: errors.join("<br>") };
                    }
                    return seriesList;
                };
                SumoLogicMetricsDatasource.prototype.doMetricsQuery = function (queries, start, end, maxDataPoints, requestedDataPoints, desiredQuantization) {
                    if (start > end) {
                        throw { message: 'Invalid time range' };
                    }
                    var queryList = [];
                    for (var i = 0; i < queries.length; i++) {
                        queryList.push({
                            'query': queries[i].expr,
                            'rowId': queries[i].requestId,
                        });
                    }
                    var url = '/api/v1/metrics/annotated/results';
                    var data = {
                        'query': queryList,
                        'startTime': start,
                        'endTime': end,
                        'maxDataPoints': maxDataPoints,
                        'requestedDataPoints': requestedDataPoints
                    };
                    if (this.quantizationDefined && desiredQuantization) {
                        data['desiredQuantizationInSecs'] = desiredQuantization;
                    }
                    console.log("sumo-logic-metrics-datasource - Datasource.doMetricsQuery: " +
                        JSON.stringify(data));
                    return this._sumoLogicRequest('POST', url, data);
                };
                SumoLogicMetricsDatasource.prototype._sumoLogicRequest = function (method, url, data) {
                    var options = {
                        url: this.url + url,
                        method: method,
                        data: data,
                        withCredentials: this.basicAuth,
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": this.basicAuth,
                        }
                    };
                    return this.backendSrv.datasourceRequest(options).then(function (result) {
                        return result;
                    }, function (err) {
                        if (err.status !== 0 || err.status >= 300) {
                            if (err.data && err.data.error) {
                                throw {
                                    message: 'Sumo Logic Error: ' + err.data.error,
                                    data: err.data,
                                    config: err.config
                                };
                            }
                            else {
                                throw {
                                    message: 'Network Error: ' + err.statusText + '(' + err.status + ')',
                                    data: err.data,
                                    config: err.config
                                };
                            }
                        }
                    });
                };
                SumoLogicMetricsDatasource.prototype.calculateInterval = function (interval) {
                    var m = interval.match(durationSplitRegexp);
                    var dur = moment_1.default.duration(parseInt(m[1]), m[2]);
                    var sec = dur.asSeconds();
                    if (sec < 1) {
                        sec = 1;
                    }
                    return Math.ceil(sec);
                };
                ;
                SumoLogicMetricsDatasource.prototype.changeQuantization = function () {
                    this.quantizationDefined = true;
                };
                ;
                return SumoLogicMetricsDatasource;
            })();
            exports_1("default", SumoLogicMetricsDatasource);
        }
    }
});
//# sourceMappingURL=datasource.js.map