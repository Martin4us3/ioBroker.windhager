/* eslint-disable no-inner-declarations */
'use strict';

const utils                     = require('@iobroker/adapter-core');
const {OId, WindhagerDevice}    = require('./lib/windhager');
const config                    = require('./lib/windhager-config.json');

class Windhager extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'windhager',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async getWindhagerConfig() {
// Windhager state configuration
        const configStateId = 'system.adapter.windhager.state-config';
        const configState = await this.getForeignStateAsync(configStateId);

        if (configState && configState.val !== '') {
            return JSON.parse(configState.val);
        } else {
            this.log.debug('Windhager config not found - use code default');
            const config = require('./lib/windhager-config.json');
            this.setForeignObjectNotExistsAsync(configStateId, {
                type: 'state',
                common: {
                    name: 'windhager-config',
                    desc: 'Windhager configuration info',
                    type: 'json',
                    role: 'config',
                    read: 'true',
                    write: 'true'
                },
                native: {}
            }).then(() => {
                this.setForeignState(configStateId, {val: JSON.stringify(config), ack: true});
            });
            return config;
        }
    }

    createStateObj({oId, dp, id, obj}) {
        if(!oId) oId = dp ? dp.OID : obj ? obj.native.OID : undefined;

        const dpInfo = this.windhager.getDpInfo( dp || oId );
        const iCommon = obj ? obj.common : {};

        const common = {
            name:   iCommon.name || dpInfo.indentText,
            type:   iCommon.type || dpInfo.dataType || 'string',
            read:   true,
            write:  iCommon.write || !(dpInfo.writeProt),
        };
// Unit
        const unit = iCommon.unit || dpInfo.unit;
        if ( unit ) common.unit = unit;

// validation
        const min = iCommon.min || dpInfo.minValue;
        if( min ) common.min = min;
        const max = iCommon.max || dpInfo.maxValue;
        if( max ) common.min = min;

        const enums = iCommon.states || dpInfo.enums;
        if( enums ) common.states = enums;

        const native = {
            OID: oId
        };

// cache
        this.mapping[oId] = id;

// create state
        return {
            type: 'state',
            common: common,
            native: native
        };
    }

    async getAllSubnetObjectRows() {
        const r = this.namespace + '.' + this.windhager.subnet;
        const params = {startkey: r, endkey: r + '.\u9999'};
        return this.getObjectViewAsync('windhager', 'subnetObjects', params);
    }

    async getAllSubnetStateRows() {
        return this.getObjectViewAsync('windhager', 'subnetStates', {startkey: '', endkey: '\u9999'});
    }

    async deleteAllStates() {
        this.mapping = {};
        const o = await this.getAllSubnetObjectRows();
        const allObjects = o.rows.reduce((result, row) => {
            result[row.id] = row.value;
            return result;
        }, {});
        await Promise.all(
            Object.keys(allObjects).map(id => this.delObjectAsync(id))
        );
    }

    validateStateValue(obj, state) {
        const c = obj.common;
        let valErr = undefined;

        if (!c.write) valErr = 'state is write protected';
        else if (c.type !== typeof state.val) valErr = 'wrong state type';
        else if (c.states && !c.states[state.val]) valErr = 'wrong enum entry';
        else if (c.min && state.val < c.min) valErr = 'value smaller then min value';
        else if (c.max && state.val > c.max) valErr = 'value greater then max value';
        return valErr;
    }

    async writeWindhagerState(obj, state) {
        const err = false; //this.validateStateValue(obj, state);
        if (err) {
            throw `state cannot set: ${err}`;
        } else {
            await this.windhager.putDatapoint(obj.native.OID, state.val);
            this.setState(obj._id, {val: state.val, ack: true});
        }
    }

//-- import-functions--------------------------------------------------------------------------------------------------

    async importDeviceStructure(imp, deleteBefore = false) {
        await this.windhager.initStructureInfo();

        // default root and Windhager fct objects
        const subnet = this.windhager.subnet;

        try {
            // delete all channels and states
            if (deleteBefore) await this.deleteAllStates();

            // initialize new state structure
            let objs;
            if (imp.type === 'flat') {
                objs = Object.entries(imp.states).reduce((objs, [id, obj]) => {
                    try {
                        const nId = this.namespace + '.' + id;
                        if (obj.type === 'state') {
                            if (obj.native && obj.native.OID) {
                                objs[nId] = this.createStateObj({
                                    id: nId,
                                    obj: obj
                                });
                            } else
                                this.log.error(`OID missing in import state ${id}`);
                        } else
                            objs[nId] = obj;
                    } catch (e) {
                        this.log.error(`error importing object ${id}: ${e.message}`);
                    }
                    return objs;
                }, {});
            } else if (imp.type === 'struct') {
                objs = Object.entries(this.windhager.fct).reduce((sObjs, [id, obj]) => {
                    const fctId = `${subnet}.${id}` ;
                    const fctType = obj.fctType;
                    if (fctType && imp.fctType[fctType]) {
                        sObjs[this.namespace + '.' + fctId] = {
                            'type': 'device',
                            'common': {
                                'name': obj.name
                            },
                            'native': {
                                'fctType': fctType
                            }
                        };
                        sObjs = Object.entries(imp.fctType[fctType]).reduce((fObjs, [id, obj]) => {
                            try {
                                const stateId = `${this.namespace}.${fctId}.${id}`;
                                if (obj.type === 'state') {
                                    if (obj.native && obj.native.OID) {
                                        fObjs[stateId] = this.createStateObj({
                                            oId: `/${fctId.replace(/\.|-/g, '/')}${obj.native.OID}`,
                                            id: stateId,
                                            obj: obj
                                        });
                                    } else
                                        this.log.error(`OID missing in import state ${id}`);
                                } else
                                    fObjs[stateId] = {obj: obj};
                            } catch (e) {
                                this.log.error(`error importing object ${id} of fctType ${fctType}: ${e.message}`);
                            }
                            return fObjs;
                        }, sObjs);
                    }
                    return sObjs;
                }, {});
            } else {
                throw new Error(`unknown import type ${imp.type}`);
            }

            await Object.entries(objs).forEach( async ([id, obj]) => {
                await this.setObjectNotExistsAsync(id, obj);
            });
            this.log.info(`${Object.keys(objs).length} states created`);
        } catch (e) {
            this.log.error(`error during import of state structure: ${e.message}`);
        }
    }

    async createWindhagerDefaultStructure(deleteBefore = false) {
        // delete all channels and states
        if (deleteBefore) await this.deleteAllStates();

        // read Windhager ressources
        await this.windhager.initStructureInfo();

        // default root and Windhager fct objects
        const subnet = this.windhager.subnet;
        const structObjs = Object.entries(this.windhager.fct).reduce((objs, [id, fct]) => {
                objs[`${subnet}.${id}`] = {
                    type: 'device',
                    common: {name: fct.name},
                    native: {fctType: fct.fctType}
                };
                return objs;
            }, {});

        // prepare all objs ...channel, states
        const objs = {};
        Object.values(this.windhager.getAllKnownDps()).forEach(dp => {
            try {
                const oId = OId(dp.OID);
                const channelId = `${subnet}.${oId.fctId}.${dp.levelId}`;
                const stateId   = `${channelId}.${oId.name}`;

                // create channel, if needed
                if (!objs[channelId]) {
                    objs[channelId] = {
                        type: 'channel',
                        common: {name: this.windhager.getLevelName(this.windhager.fct[oId.fctId].fctType, dp.levelId)},
                        native: {}
                    };
                }
                // state
                objs[stateId] = this.createStateObj({dp: dp, id: stateId});
            } catch (err) {
                this.log.warn(err.message);
            }
        });

// write function objects
        Object.entries(structObjs).forEach(([id, data]) => {
            this.setObjectNotExistsAsync(id, data);
        });

// sort and write all state objects
        const ordered = Object.keys(objs).sort().reduce(
            (obj, key) => {
                obj[key] = objs[key];
                return obj;
            }, {}
        );
        Object.entries(ordered).forEach(([id, obj]) => {
            this.setObjectNotExistsAsync(id, obj);
        });
        this.log.info(`${Object.keys(ordered).length} states created`);
    }

//-- export-functions--------------------------------------------------------------------------------------------------

    getKnownDpsExport() {
        if(this.windhager.knownDPs) {
            return this.windhager.knownDPs;
        } else {
            return { msg: 'no scan result available - please start fullScan before' };
        }
    }

    getFctTypeFromKnownDpsExport() {
        if(this.windhager.knownDPs) {
            const exp = Object.values(this.windhager.knownDPs).reduce( (exp, dp) => {
                const oid = OId(dp.OID);
                const fctType = this.windhager.fct[oid.fctId].fctType;
                if(!exp[fctType]) exp[fctType] = {};

                const eDp = Object.assign({}, dp);
                delete eDp.OID;

                if(exp[fctType][eDp.name]) {
                    if(JSON.stringify(exp[fctType][eDp.name]) !== JSON.stringify(eDp)) {
                        this.log.warn(`different datapoint ${eDp.name} in fctType ${fctType}`);
                        if(!exp.diff)                        exp.diff = {};
                        if(!exp.diff[fctType])               exp.diff[fctType] = {};
                        if(!exp.diff[fctType][eDp.name])     exp.diff[fctType][eDp.name] = [];

                        exp.diff[fctType][eDp.name][0] = exp[fctType][eDp.name];
                        exp.diff[fctType][eDp.name].push(eDp);
                    }
                } else {
                    exp[fctType][eDp.name] = eDp;
                }
                return exp;
            }, {});

            function sort(fct) {
                return Object.keys(fct).sort().reduce(
                    (obj, key) => { obj[key] = fct[key]; return obj; }, {}
                );
            }
            Object.keys(exp).forEach(fctType => {
                if(fctType !== 'diff')
                    exp[fctType] = sort(exp[fctType]);
            });
            return exp;
        } else {
            return { msg: 'no scan result available - please start fullScan before' };
        }
    }

    getKnownFctTypeExport() {
        return this.windhager.config.knownFctType;
    }

    async getStateStructureExport() {
        const res = await this.getAllSubnetObjectRows();
        const firstFct = {};
        const objs = res.rows.reduce((result, {id, value}) => {
            try {
                const [match, subnet, fct, sId] = id.match(new RegExp(`^${this.namespace}\\.(\\d+)\\.?(\\d\\d-\\d)?\\.?(.+)?`, ''));
                if (match && (fct !== undefined)) {
                    const fctObj = {
                        type:   value.type,
                        common: value.common,
                        native: value.native
                    };
                    if (!result.subnet) result.subnet = subnet;
                    if (value.type === 'device') {
                        const fctType = fctObj.native.fctType;
                        result.fct[fct] = fctObj;
                        if (!firstFct[fctType]) {
                            firstFct[fctType] = fct;
                            result.fctType[fctType] = {};
                        }
                    } else {
                        const fctType = result.fct[fct].native.fctType;
                        if (firstFct[fctType] === fct) {                    // only states of first founded function
                            if (fctObj.native && fctObj.native.OID) {       // prepare OID
                                const [oMatch, oSubnet, oFct, oId] = fctObj.native.OID.match(/^\/(\d+)\/(\d+\/\d+)(.+)/, ``);
                                fctObj.native.OID = oId;
                            }
                            result.fctType[fctType][sId] = fctObj;
                        }
                    }
                }
            } catch (e) {
                this.log.warn(`export error: ${e.message}`);
            }
            return result;
        }, {model: "windhager.adapter.export", type: "struct", subnet: null, fct: {}, fctType: {}});
        return objs;
    }

    async getBackupStructureExport() {
        const res = await this.getAllSubnetObjectRows();
        const objs = {
            model: "windhager.adapter.export",
            type: "flat",
            states: res.rows.reduce((result, {id, value}) => {
                try {
                    const [match, sId] = id.match(new RegExp(`^${this.namespace}\\.(.+)`, '')); // `^windhager\.\d+\.((\d+)\.(\d+-\d+)\..+)`
                    if (match) {
                        result[sId] = {
                            type: value.type,
                            common: value.common,
                            native: value.native
                        };
                    } else {
                        throw new Error('wrong id structure');
                    }
                } catch (e) {
                    this.log.warn(`export error: ${e.message}`);
                }
                return result;
            }, {})
        }
        return objs;
    }

    async export( exportType ) {
        await this.setObjectNotExistsAsync('info.export_data', {
            type: 'state',
            common: {
                name: 'export_data',
                type: 'json',
                role: 'config',
                expert: true
            },
            native: {}
        });
        const functions = {
            "1": "getKnownDpsExport",
            "2": "getFctTypeFromKnownDpsExport",
            "3": "getKnownFctTypeExport",
        };
        const asyncFunctions = {
            "4": "getStateStructureExport",
            "5": "getBackupStructureExport"
        };

        const   exp  = functions[exportType] ? this[functions[exportType]]() :
                                    (asyncFunctions[exportType] ? await this[asyncFunctions[exportType]]() : undefined);
        if(exp)
            await this.setState('info.export_data', {val: JSON.stringify(exp), ack: true})
        else
            this.log.error('cannot find export type');
    }

    async readMapping() {
        const allStates = await this.getAllSubnetStateRows();
        this.mapping = allStates.rows.reduce((result, row) => {
            if (row.value.native && row.value.native.OID) {
                result[row.value.native.OID] = row.id.substring(this.namespace.length + 1, row.id.length);
            }
            return result;
        }, {});
    }

    async updateWindhagerData() {
        this.status = 'update';
        const start = Date.now();
        let count = {
            use:    0,
            notUse: 0
        };
        try {
            const dps = await this.windhager.getDatapoints();
            for(let i in dps) {
                const dp = dps[i];
                const id = this.mapping[dp.OID];
                if(id) {
                    this.setState(id, {
                        val: this.windhager.getDpTypeInfo(dp).dataType === 'number' ? Number(dp.value) : dp.value,
                        ack: true
                    });
                    count.use++;
                    this.extendObjectAsync(id, {
                        native: {
                            DP_TIME: dp.timestamp
                        }
                    })
                } else {
                    count.notUse++;
                }
            }
        } catch (e) {
            this.log.warn(`error during update request ${e.message}`);
        }
        this.log.debug(`update ${count.use} Windhager states in ${Date.now() - start} milliseconds; ${count.notUse} states not used`);
        this.status = 'sleep';
    }

    async lookupWindhagerData() {
        this.status = 'lookup';
        const start = Date.now();
        let count = 0;
        const dps = Object.keys(this.mapping);
        for (let i = 0; i < dps.length; i++) {
            try {
                const dp = await this.windhager.lookup(dps[i]);
                const id = this.mapping[dp.OID];
                this.log.debug(`read datapoint ${dp.OID} to state ${id ? id : 'no state found'}`);
                if (id) {
                    this.setState(id, {
                        val: this.windhager.getDpTypeInfo(dp).dataType === 'number' ? Number(dp.value) : dp.value,
                        ack: true
                    });
                    this.extendObjectAsync(id, {
                        native: {
                            DP_TIME: dp.timestamp
                        }
                    })
                    count++;
                }
            } catch (e) {
                this.log.warn(`haven't got value for datapoint ${dps[i]}; error: ${e.message}`);
            }
        }
        this.log.debug(`lookup ${count} Windhager states in ${Date.now() - start} milliseconds` +
            ((count < this.mapping.length) ? `; ${this.mapping.length - count} loosed` : ''));
        this.status = 'sleep';
    }

    async intervalUpdate() {
        if(this.status !== 'lookup') {
            await this.updateWindhagerData();
        }
        this.timeout = setTimeout(() => {
            this.intervalUpdate();
        }, this.updateInterval);
    }

    async startWindhager(connectTries = 1) {
        try {
            this.log.debug('connect to Windhager...');

            this.windhager = new WindhagerDevice(await this.getWindhagerConfig(), this.log, this.config.ip);
            const subnet = await this.windhager.logIn(this.config.login, this.config.password);

            this.setStateAsync('info.connection', { ack: true, val: true });
            this.log.info('Windhager connected');

            // are there knowDPs of previous scan
            var cfgObj = await this.getForeignObjectAsync( this.namespace );
            if( cfgObj && cfgObj.native && cfgObj.native.knownDPs ) {
                this.windhager.knownDPs = cfgObj.native.knownDPs;
                this.log.debug('known datapoints of previous system scan found');
            }

            this.status = 'initialize';
            await this.windhager.init( this.reInitConfig && this.reInitConfig.fullScan );
            if( this.reInitConfig && this.reInitConfig.fullScan ) {
                await this.extendForeignObjectAsync(this.namespace, {
                    native: {
                        knownDPs: this.windhager.knownDPs
                    }
                });
                this.log.debug('known datapoints of system scan stored');
            }    // store after fullScan

            this.mapping = {};

            // initilize structure needed?
            if ( this.reInitConfig && this.reInitConfig.cmd && this.reInitConfig.cmd !== 'none') {
                this.log.debug('initialize state structure...');
                if (this.reInitConfig.cmd === 'import')
                    await this.importDeviceStructure(this.reInitConfig.file, this.reInitConfig.deleteStruct);
                else if (this.reInitConfig.cmd === 'default')
                    await this.importDeviceStructure(this.windhager.config['defaultStruct'], this.reInitConfig.deleteStruct);
                else if (this.reInitConfig.cmd === 'windhager')
                    await this.createWindhagerDefaultStructure(this.reInitConfig.deleteStruct);
            } else {
                await this.readMapping();
            }

            this.log.info('start regular update of states');
            this.intervalUpdate();
        } catch (e) {
            this.log.error('exception: ' + e);
            await this.setStateAsync('info.connection', { ack: true, val: false });

            delete this.windhager;

            let stopProcess = true;
            if (e.name && e.name === 'JSONResponseFormatError') {
                if (e.status === 401) {
                    this.log.error('wrong user/password for Windhager - adapter disabled');
                } else if (e.status === 'xxx') {
                    if (connectTries < 5) {
                        this.log.error('timeout trying to connect Windhager... try again in 5 min. - ' + e.message);
                        this.timeout = setTimeout(() => {
                            this.startWindhager(++connectTries);
                        }, 5 * 60 * 1000);
                        stopProcess = false;
                    } else {
                        this.log.error('could not connect to Windhager... adapter stopped' + e.message);
                    }
                }
            }
            if (stopProcess) {
                await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {common: {enabled: false}});
                this.stop();
            }
        }
    }

    get status() {
        return this._status;
    }

    set status( status ) {
        this._status = status;
        this.setStateAsync('info.status', { ack: true, val: status });
    }

    async onReady() {
        this.status = 'start adapter';

        this.updateInterval = this.config.updateInterval * 1000;   // update interval

        // is there any reInitializeConfig
        const rootInst = await this.getForeignObjectAsync(this.namespace);
        if(rootInst && rootInst.native && rootInst.native.reInit)
            this.reInitConfig = rootInst.native.reInit;

        await this.startWindhager();

        // delete reInitializeConfig if exists
        if(this.reInitConfig)
            await this.extendForeignObjectAsync(this.namespace, { native: {reInit: null}});

        this.subscribeStates('*');
        this.subscribeObjects('*');

        this.log.debug('onReady end');
    }

    onUnload(callback) {
        try {
            callback();
        } catch (e) {
            callback();
        }
    }

    getLocalId( fId ) {
        const m = fId.match(new RegExp(`^${this.namespace}.(...+)`, '')); //     /^windhager.0.(...+)/);
        return m ? m[1] : undefined;
    }

    mappingGetOid( sId ) {
        const e = Object.entries(this.mapping).find(([oId, mId]) => (mId === sId));
        if (e) return e[0];
    }

    mappingGetSid( oId ) {
        return this.mapping[ oId ];
    }

    async onObjectChange(id, obj) {
        const lId = this.getLocalId(id);
        if(lId) {
            const oId = this.mappingGetOid(lId);
            if( !obj ) {
                if( oId ) delete this.mapping[oId];
            } else if(obj.from !== 'system.adapter.windhager.0' && obj.type === 'state') {
                let mappingChanged = true;
                if (obj.native && obj.native.OID) {
                    if (oId && obj.native.OID === oId) {
                        mappingChanged = false;
                    } else {
                        const oOidStateId = this.mapping[obj.native.OID];
                        if (oOidStateId) {
                            const oOidState = await this.getObjectAsync(oOidStateId);
                            if (oOidState && oOidState.native && oOidState.native.OID) {
                                delete oOidState.native.OID;
                                await this.setObjectAsync(oOidStateId, oOidState);
                                await this.setState(oOidStateId, {val: null, ack: true});
                            }
                        }
                        this.mapping[obj.native.OID] = lId;
                    }
                } else {
                    if (!oId) mappingChanged = false;
                }
                if (mappingChanged) {
                    if (oId) delete this.mapping[oId];
                    await this.setState(lId, {val: null, ack: true});
                }
            }
        }
    }

    async onStateChange(id, state) {
        if (state && !state.ack) {
            try {
                const k = id.split('.');
                if(k[2] === 'info') {
                    switch(k[3]) {
                        case 'lookup':
                            this.log.info('lookup all current Windhager data');
                            if(this.status !== 'lookup')
                                await this.lookupWindhagerData();
                            break;
                        case 'export':
                            this.log.info('trigger export');
                            if(state.val !== 0)
                                await this.export(state.val);
                            this.setState(id, {val: 0, ack: true}); // done
                            break;
                    }
                } else
                if (k[2] == this.windhager.subnet) {
                    const obj = await this.getObjectAsync(id);
                    if(obj && obj.native && obj.native.OID) {
                        await this.writeWindhagerState(obj, state);
                        this.setState(id, {val: state.val, ack: true});
                    }
                }
            } catch (error) {
                this.log.error(`Error ${error}`);
            }
        }
    }
}

if (module.parent) {
    module.exports = (options) => new Windhager(options);
} else {
    new Windhager();
}
