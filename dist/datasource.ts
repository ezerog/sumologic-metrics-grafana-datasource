///<reference path="../node_modules/grafana-sdk-mocks/app/headers/common.d.ts" />

import _ from 'lodash';
import moment from 'moment';
import * as dateMath from 'app/core/utils/datemath';

const durationSplitRegexp = /(\d+)(ms|s|m|h|d|w|M|y)/;

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
export default class SumoLogicMetricsDatasource {

  url: string;
  basicAuth: boolean;
  start: number;
  end: number;
  error: string;
  quantizationDefined: boolean;

  /** @ngInject */
  constructor(instanceSettings, private backendSrv, private templateSrv, private $q) {
    this.url = instanceSettings.url;
    this.basicAuth = instanceSettings.basicAuth;
    console.log("sumo-logic-metrics-datasource - Datasource created.");
  }

  // Main API.

  // Called by Grafana to, well, test a datasource. Invoked
  // during Save & Test on a Datasource editor screen.
  testDatasource() {
    return this.metricFindQuery('metrics|*').then(() => {
      return {status: 'success', message: 'Data source is working', title: 'Success'};
    });
  }

  // Called by Grafana to find values for template variables.
  metricFindQuery(query) {

    // Bail out immediately if the caller didn't specify a query.
    if (!query) {
      return this.$q.when([]);
    }

    // With the help of templateSrv, we are going to first of all figure
    // out the current values of all template variables.
    let templateVariables = {};
    _.forEach(_.clone(this.templateSrv.variables), variable => {
      let name = variable.name;
      let value = variable.current.value;

      // Prepare the an object for this template variable in the map
      // following the same structure as options.scopedVars from
      // this.query() so we can then in the next step simply pass
      // on the map to templateSrv.replace().
      templateVariables[name] = {'selelected': true, 'text': value, 'value': value};
    });

    // Resolve template variables in the query to their current value.
    let interpolated;
    try {
      interpolated = this.templateSrv.replace(query, templateVariables);
    } catch (err) {
      return this.$q.reject(err);
    }

    // The catalog query API returns many duplicate results and this
    // could be a problem. Maybe figure out how to do the same thing
    // with the autocomplete API?
    if (interpolated.startsWith("dimensions|")) {
      return this.getAvailableDimensions(interpolated);
    } else if (interpolated.startsWith("metaTags|")) {
      return this.getAvailableMetaTags(interpolated);
    } else if (interpolated.startsWith("metrics|")) {
      return this.getAvailableMetrics(interpolated);
    } else if (interpolated.startsWith("values|")) {
      return this.getValuesFromAutocomplete(interpolated);
    }

    // Unknown query type - error.
    return this.$q.reject("Unknown metric find query: " + query);
  }

  getAvailableDimensions(interpolatedQuery) {
    let split = interpolatedQuery.split("|");

    // The metatag whose values we want to enumerate.
    let parameter = split[1];

    // The query to constrain the result - a metrics selector.
    let actualQuery = split[2];

    // PLEASE NOTE THAT THIS IS USING AN UNOFFICIAL APU AND IN
    // GENERAL EXPERIMENTAL - BUT IT IS BETTER THAN NOTHING AND
    // IT DOES IN FACT WORK. WE WILL UPDATE TEMPLATE VARIABLE
    // QUERY FUNCTIONALITY ONCE AN OFFICIAL PUBLIC API IS OUT.
    //
    // This gives us the values of the dimension given in parameter.
    // In Sumo Logic, a time series is associated with dimensions, and
    // metatags. Dimensions are key-value pairs that are part of the
    // identity of the time series. Metatags are additional key-value
    // pairs that are NOT part of the identity of the time series.
    //
    // We are using the inofficial catalog query endpoint here.
    // This endpoint expects a Sumo Logic metrics selector and will
    // return all metrics known given the selector, along with all
    // metatags and dimensions for those metrics. We will then look
    // through all the returned dimensions that match the specified
    // parameter and collect the distinct set of values.
    //
    // For example, given the following query for the template variable:
    //
    // dimensions|DBInstanceIdentifier|namespace=AWS/RDS metric=CPUUtilization
    //
    // This produces a result like the following:
    //
    // {
    //   "results": [
    //   {
    //     "name": "CPUUtilization",
    //     "dimensions": [
    //       {
    //         "key": "DBInstanceIdentifier",
    //         "value": "prod-analytics-rds-2017-08-15-2"
    //       },
    //       {
    //         "key": "Statistic",
    //         "value": "Sum"
    //       },
    //       {
    //         "key": "metric",
    //         "value": "CPUUtilization"
    //       },
    //     ],
    //     "metaTags": [
    //       {
    //         "key": "_sourceCategory",
    //         "value": "aws/cloudwatch"
    //       },
    //       {
    //         "key": "_contentType",
    //         "value": "AwsCloudWatch"
    //       },
    //       ...
    //     ]
    //   },
    //   ...
    // ]
    //
    // We are looking through the entire result, which can be very verbose
    // and are simply trying to fish out all the values for dimension
    // "_sourceCategory"

    let url = '/api/v1/metrics/meta/catalog/query';
    let data = '{"query":"' + actualQuery + '", "offset":0, "limit":100000}';
    return this._sumoLogicRequest('POST', url, data)
      .then(result => {
        let dimensionValues = _.map(result.data.results, resultEntry => {
          let dimensions = resultEntry.dimensions;
          let dimensionCount = dimensions.length;
          let dimension = null;
          for (let dimensionIndex = 0; dimensionIndex < dimensionCount; dimensionIndex++) {
            dimension = dimensions[dimensionIndex];
            if (dimension.key === parameter.trim()) {
              break;
            }
          }
          return {
            text: dimension.value,
            expandable: true
          };
        });
        return _.uniqBy(dimensionValues, 'text');
      });
  }

  getAvailableMetaTags(interpolatedQuery) {
    let split = interpolatedQuery.split("|");

    // The metatag whose values we want to enumerate.
    let parameter = split[1];

    // The query to constrain the result - a metrics selector.
    let actualQuery = split[2];

    // PLEASE NOTE THAT THIS IS USING AN UNOFFICIAL APU AND IN
    // GENERAL EXPERIMENTAL - BUT IT IS BETTER THAN NOTHING AND
    // IT DOES IN FACT WORK. WE WILL UPDATE TEMPLATE VARIABLE
    // QUERY FUNCTIONALITY ONCE AN OFFICIAL PUBLIC API IS OUT.
    //
    // This gives us the values of the metatag given in parameter.
    // In Sumo Logic, a time series is associated with dimensions, and
    // metatags. Dimensions are key-value pairs that are part of the
    // identity of the time series. Metatags are additional key-value
    // pairs that are NOT part of the identity of the time series.
    //
    // We are using the inofficial catalog query endpoint here.
    // This endpoint expects a Sumo Logic metrics selector and will
    // return all metrics known given the selector, along with all
    // metatags and dimensions for those metrics. We will then look
    // through all the returned metatags that match the specified
    // parameter and collect the distinct set of values.
    //
    // For example, given the following query for the template variable:
    //
    // metaTags|_sourceCategory|_contentType=HostMetrics metric=CPU_LoadAvg_1Min
    //
    // This produces a result like the following:
    //
    // {
    //   "results": [
    //   {
    //     "name": "CPU_LoadAvg_1min",
    //     "dimensions": [
    //       {
    //         "key": "metric",
    //         "value": "CPU_LoadAvg_1min"
    //       },
    //       ...
    //     ],
    //     "metaTags": [
    //       {
    //         "key": "_sourceCategory",
    //         "value": "forge"
    //       },
    //       {
    //         "key": "_contentType",
    //         "value": "HostMetrics"
    //       },
    //       ...
    //     ]
    //   },
    //   ...
    // ]
    //
    // We are looking through the entire result, which can be very verbose
    // and are simply trying to fish out all the values for metatag
    // "_sourceCategory".

    let url = '/api/v1/metrics/meta/catalog/query';
    let data = '{"query":"' + actualQuery + '", "offset":0, "limit":100000}';
    return this._sumoLogicRequest('POST', url, data)
      .then(result => {
        let metaTagValues = _.map(result.data.results, resultEntry => {
          let metaTags = resultEntry.metaTags;
          let metaTagCount = metaTags.length;
          let metaTag = null;
          for (let metaTagIndex = 0; metaTagIndex < metaTagCount; metaTagIndex++) {
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
        return _.uniqBy(metaTagValues, 'text');
      });
  }

  getAvailableMetrics(interpolatedQuery) {
    let split = interpolatedQuery.split("|");

    // The query to constrain the result - a metrics selector.
    let actualQuery = split[1];

    // PLEASE NOTE THAT THIS IS USING AN UNOFFICIAL APU AND IN
    // GENERAL EXPERIMENTAL - BUT IT IS BETTER THAN NOTHING AND
    // IT DOES IN FACT WORK. WE WILL UPDATE TEMPLATE VARIABLE
    // QUERY FUNCTIONALITY ONCE AN OFFICIAL PUBLIC API IS OUT.
    //
    // For context, please see getAvailableDimensions() or
    // getAvailableMetatags. We are using the same unofficial endpoint
    // here to snarf up all the actual metrics that are available
    // given the supplied metrics selector in query.
    //
    // For example, given the following query for the template variable:
    //
    // metrics|_contentType=HostMetrics
    //
    // This produces a result like the following:
    //
    // {
    //   "results": [
    //   {
    //     "name": "Disk_WriteBytes",
    //     "dimensions": [
    //       ...
    //     ],
    //     "metaTags": [
    //       ...
    //     ]
    //   },
    //   {
    //     "name": "Disk_InodesAvailable",
    //     "dimensions": [
    //       ...
    //     ],
    //     "metaTags": [
    //       ...
    //     ]
    //   },
    //   ...
    // ]
    //
    // We are looking through the entire result, which can be very verbose
    // and are simply trying to fish out all the values for metric to get
    // a full list of all metrics available for _contentType=HostMetrics.

    let url = '/api/v1/metrics/meta/catalog/query';
    let data = '{"query":"' + actualQuery + '", "offset":0, "limit":100000}';
    return this._sumoLogicRequest('POST', url, data)
      .then(result => {
        let metricNames = _.map(result.data.results, resultEntry => {
          let name = resultEntry.name;
          return {
            text: name,
            expandable: true
          };
        });
        return _.uniqBy(metricNames, 'text');
      });
  }

  getValuesFromAutocomplete(interpolatedQuery) {
    let split = interpolatedQuery.split("|");

    // The metatag whose values we want to enumerate.
    let key = split[1];

    // The query to constrain the result - a metrics selector.
    let metricsSelector = split[2];

    // PLEASE NOTE THAT THIS IS USING AN UNOFFICIAL APU AND IN
    // GENERAL EXPERIMENTAL - BUT IT IS BETTER THAN NOTHING AND
    // IT DOES IN FACT WORK. WE WILL UPDATE TEMPLATE VARIABLE
    // QUERY FUNCTIONALITY ONCE AN OFFICIAL PUBLIC API IS OUT.
    //
    // Returns the values for the key specified as the parameter
    // given the metrics selector given in query. This is a much
    // more efficient way to get the value for a key than the
    // method used in getAvailableMetaTags() which might return
    // a lot of duplicated data.
    //
    // Given key '_sourceCategory' and metrics selector
    // '_contentType=HostMetrics metric=CPU_LoadAvg_1Min' this
    // will ask the autocomplete endpoint for all values for
    // key '_sourceCategory' by constructing the following
    // autocomplete query:
    //
    //  _contentType=HostMetrics metric=CPU_LoadAvg_1Min _sourceCategory=
    //
    // We also need to tell the autocomplete endpopint the
    // position of the "cursor", so it notes from where in the
    // query it should find completitions from. The result will
    // look something like this:
    //
    // {
    //   "queryId": 0,
    //   "query": "_contentType=HostMetrics metric=CPU_LoadAvg_1Min _sourceCategory=",
    //   "pos": 65,
    //   "queryStartTime": 0,
    //   "queryEndTime": 0,
    //   "suggestions": [
    //   {
    //     "sectionName": "Values",
    //     "highlighted": null,
    //     "items": [
    //       {
    //         "display": "alert",
    //         ...
    //       },
    //       {
    //         "display": "analytics",
    //         ...
    //         }
    //       },
    //       {
    //         "display": "attack",
    //         ...
    //       },
    //       ...
    //     ]
    // ],
    // ...
    // }

    // Create the final query with the key appended.
    let finalQuery = metricsSelector + " " + key + "=";
    let position = finalQuery.length;

    let startTime = this.start || 0;
    let endTime = this.end || 0;
    let url = '/api/v1/metrics/suggest/autocomplete';
    let data = `
      {
        "queryId": "1",
        "query": "${finalQuery}",
        "pos": ${position},
        "apiVersion": "0.2.0",
        "queryStartTime": ${startTime},
        "queryEndTime": ${endTime},
        "requestedSectionsAndCounts": {
          "values": 1000
        }
      }`;
    return this._sumoLogicRequest('POST', url, data)
      .then(result => {
        return _.map(result.data.suggestions[0].items, suggestion => {
          return {
            text: suggestion.display,
          };
        });
      });
  }

  // Called by Grafana to execute a metrics query.
  query(options) {

    let self = this;

    // Get the start and end time for the query. Remember the values so
    // we can reuse them during performSuggestQuery, where we will also
    // need a time range.
    this.start = options.range.from.valueOf();
    this.end = options.range.to.valueOf();

    // This gives us the upper limit of data points to be returned
    // by the Sumo backend and seems to be based on the width in
    // pixels of the panel.
    let maxDataPoints = options.maxDataPoints;

    // Empirically, it seems that we get better looking graphs
    // when requesting some fraction of the indicated width...
    let requestedDataPoints = Math.round(maxDataPoints / 6);

    // Figure out the desired quantization.
    let desiredQuantization = this.calculateInterval(options.interval);

    const targets = options.targets;
    const queries = [];
    _.each(options.targets, target => {
      if (!target.expr || target.hide) {
        return;
      }

      // Reset previous errors, if any.
      target.error = null;

      let query: any = {};
      query.expr = this.templateSrv.replace(target.expr, options.scopedVars);
      query.requestId = options.panelId + target.refId;
      queries.push(query);
    });

    // If there's no valid targets, return the empty result to
    // save a round trip.
    if (_.isEmpty(queries)) {
      let d = this.$q.defer();
      d.resolve({data: []});
      return d.promise;
    }

    // Set up the promises.
    let queriesPromise = [
      this.doMetricsQuery(
        queries,
        this.start,
        this.end,
        maxDataPoints,
        requestedDataPoints,
        desiredQuantization)];

    // Execute the queries and collect all the results.
    return this.$q.all(queriesPromise).then(responses => {
      let result = [];
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i];
        if (response.status === 'error') {
          throw response.error;
        }
        const target = targets[i];
        result = self.transformMetricData(targets, response.data.response);
      }

      // Return the results.
      return {data: result};
    });
  }

  // Helper methods.

  // Called from SumoLogicMetricsQueryCtrl.
  performSuggestQuery(query) {
    let url = '/api/v1/metrics/suggest/autocomplete';
    let data = {
      query: query,
      pos: query.length,
      queryStartTime: this.start,
      queryEndTime: this.end
    };
    return this._sumoLogicRequest('POST', url, data).then(result => {
      let suggestionsList = [];
      _.each(result.data.suggestions, suggestion => {
        _.each(suggestion.items, item => {
          suggestionsList.push(item.replacement.text);
        });
      });
      return suggestionsList;
    });
  }

  // Transform results from the Sumo Logic Metrics API called in
  // query() into the format Grafana expects.
  transformMetricData(targets, responses) {

    let seriesList = [];
    let errors = [];

    for (let i = 0; i < responses.length; i++) {
      let response = responses[i];
      let target = targets[i];

      if (!response.messageType) {
        for (let j = 0; j < response.results.length; j++) {
          let result = response.results[j];

          // Synthesize the "target" - the "metric name" basically.
          let target = "";
          let dimensions = result.metric.dimensions;
          let firstAdded = false;
          for (let k = 0; k < dimensions.length; k++) {
            let dimension = dimensions[k];
            if (dimension.legend === true) {
              if (firstAdded) {
                target += ",";
              }
              target += dimension.key + "=" + dimension.value;
              firstAdded = true;
            }
          }

          // Create Grafana-suitable datapoints.
          let values = result.datapoints.value;
          let timestamps = result.datapoints.timestamp;
          let length = Math.min(values.length, timestamps.length);
          let datapoints = [];
          for (let l = 0; l < length; l++) {
            let value = values[l];
            let valueParsed = parseFloat(value);
            let timestamp = timestamps[l];
            let timestampParsed = parseFloat(timestamp);
            datapoints.push([valueParsed, timestampParsed]);
          }

          // Add the series.
          seriesList.push({target: target, datapoints: datapoints});
        }
      } else {
        console.log("sumo-logic-metrics-datasource - Datasource.transformMetricData - error: " +
          JSON.stringify(response));
        errors.push(response.message);
        target.error = response.message;
      }
    }

    if (errors.length > 0) {
      throw {message: errors.join("<br>")};
    }

    return seriesList;
  }

  doMetricsQuery(queries, start, end, maxDataPoints,
                 requestedDataPoints, desiredQuantization) {
    if (start > end) {
      throw {message: 'Invalid time range'};
    }
    let queryList = [];
    for (let i = 0; i < queries.length; i++) {
      queryList.push({
        'query': queries[i].expr,
        'rowId': queries[i].requestId,
      });
    }
    let url = '/api/v1/metrics/annotated/results';
    let data = {
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
  }

  _sumoLogicRequest(method, url, data) {
    let options: any = {
      url: this.url + url,
      method: method,
      data: data,
      withCredentials: this.basicAuth,
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.basicAuth,
      }
    };
    return this.backendSrv.datasourceRequest(options).then(result => {
      return result;
    }, function (err) {
      if (err.status !== 0 || err.status >= 300) {
        if (err.data && err.data.error) {
          throw {
            message: 'Sumo Logic Error: ' + err.data.error,
            data: err.data,
            config: err.config
          };
        } else {
          throw {
            message: 'Network Error: ' + err.statusText + '(' + err.status + ')',
            data: err.data,
            config: err.config
          };
        }
      }
    });
  }

  calculateInterval(interval) {
    let m = interval.match(durationSplitRegexp);
    let dur = moment.duration(parseInt(m[1]), m[2]);
    let sec = dur.asSeconds();
    if (sec < 1) {
      sec = 1;
    }
    return Math.ceil(sec);
  };

  changeQuantization() {
    this.quantizationDefined = true;
  };
}
