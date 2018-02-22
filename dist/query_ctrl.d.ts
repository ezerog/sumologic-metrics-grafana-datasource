/// <reference path="../node_modules/grafana-sdk-mocks/app/headers/common.d.ts" />
import { QueryCtrl } from 'app/plugins/sdk';
export default class SumoLogicMetricsQueryCtrl extends QueryCtrl {
    private templateSrv;
    static templateUrl: string;
    defaults: {};
    suggestMetrics: any;
    showValue: any;
    makeTable: any;
    makeList: any;
    updateHtml: any;
    savedCallback: any;
    html: string;
    /** @ngInject */
    constructor($scope: any, $injector: any, templateSrv: any);
}
