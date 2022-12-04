/* eslint-disable no-inner-declarations */
'use strict';

const utils                     = require('@iobroker/adapter-core');
const {OId, WindhagerDevice }   = require('./lib/windhager');
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
        function cast(val) {
            return common.type === 'number' ? Number(val) : val;
        }

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

    async deleteAllStates() {
        const r = this.namespace + '.' + this.windhager.subnet;
        const params = {startkey: r, endkey: r + '.\u9999'};
        const o = await this.getObjectViewAsync('windhager', 'subnetObjects', params);
        const allObjects = o.rows.reduce((result, row) => {
            result[row.id] = row.value;
            return result;
        }, {});
        await Promise.all(
            Object.keys(allObjects).map(id => this.delObjectAsync(id))
        );
        this.mapping = {};
    }

    validateStateValue(id, state, obj) {
        const c = obj.common;
        let valErr = undefined;

        if (!c.write) valErr = 'state is write protected';
        else if (c.type !== typeof state.val) valErr = 'wrong state type';
        else if (c.states && !c.states[state.val]) valErr = 'wrong enum entry';
        else if (c.min && state.val < c.min) valErr = 'value smaller then min value';
        else if (c.max && state.val > c.max) valErr = 'value greater then max value';
        return valErr;
    }

    async writeWindhagerState(id, state) {
        const obj = await this.getObjectAsync(id);
        const err = this.validateStateValue(id, state, obj);
        if (err) {
            throw `state cannot set: ${err}`;
        } else {
            await this.windhager.putDatapoint(obj.native.OID, state.val);
            this.setState(id, {val: state.val, ack: true});
        }
    }

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

            Object.entries(objs).forEach(([id, obj]) => {
                this.setObjectNotExistsAsync(id, obj);
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

    async export( exportType ) {
        await this.setObjectNotExistsAsync('export', {
            type: 'state',
            common: {
                name: 'export',
                type: 'json',
                role: 'config'
            },
            native: {}
        });
        const exp = Object.values(this.windhager.getAllKnownDps()).reduce( (exp, dp) => {
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
        await this.setState('export', {val: JSON.stringify(exp), ack: true})
    }

    async readMapping() {
        const allStates = await this.getObjectViewAsync('windhager', 'subnetStates', {startkey: '', endkey: '\u9999'});
        this.mapping = allStates.rows.reduce((result, row) => {
            if (row.value.native && row.value.native.OID) {
                result[row.value.native.OID] = row.id.substring(this.namespace.length + 1, row.id.length);
            }
            return result;
        }, {});
    }

    async updateWindhagerData() {
        const start = Date.now();
        let count = 0;
        const dps = Object.keys(this.mapping);
        for (let i = 0; i < dps.length; i++) {
            try {
                const dp = await this.windhager.lookup(dps[i]);
                const id = this.mapping[dp.OID];
                if (id) {
                    this.setState(id, {
                        val: this.windhager.config.dataType[dp.typeId] === 'number' ? Number(dp.value) : dp.value,
                        ack: true
                    });
                    count++;
                }
            } catch (e) {
                this.log.warn(`haven't got value for datapoint ${dps[i]}; error: ${e.message}`);
            }
        }
        this.log.debug(`update ${count} Windhager states in ${Date.now() - start} milliseconds` +
            ((count < this.mapping.length) ? `; ${this.mapping.length - count} loosed` : ''));
    }

    async intervalUpdate() {
        this.log.info('interval update');

        await this.updateWindhagerData();
        this.timeout = setTimeout(() => {
            this.intervalUpdate();
        }, this.updateInterval);
    }

    async startWindhager(connectTries = 1) {
        try {
            this.log.debug('try to connect to Windhager...');

            this.windhager = new WindhagerDevice(await this.getWindhagerConfig(), this.log, this.config.ip);

            const subnet = await this.windhager.logIn(this.config.login, this.config.password);
            await this.setStateAsync('info.connection', { ack: true, val: true });
            this.log.info('Windhager connected');

            // are there knowDPs of previous scan
            var cfgObj = await this.getForeignObjectAsync( this.namespace );
            if( cfgObj && cfgObj.native && cfgObj.native.knownDPs ) {
                this.windhager.knownDPs = cfgObj.native.knownDPs;
                this.log.debug('known datapoints of previous system scan found');
            }

            await this.windhager.init( this.config.fullScan );
            if( this.config.fullScan ) {
                await this.extendForeignObjectAsync(this.namespace, {
                    native: {
                        knownDPs: this.windhager.knownDPs
                    }
                });
                this.log.debug('known datapoints of system scan stored');
            }    // store after fullScan

            this.mapping = {};

            // initilize structure needed?
            if ( this.config.initStruct && this.config.initStruct !== 'none') {
                this.log.debug('initialize state structure...');
                if (this.config.initStruct === 'import')
                    await this.importDeviceStructure(this.config.importFile, this.config.deleteStruct);
                else if (this.config.initStruct === 'default')
                    await this.importDeviceStructure(this.windhager.config['defaultStruct'], this.config.deleteStruct);
                else if (this.config.initStruct === 'windhager')
                    await this.createWindhagerDefaultStructure(this.config.deleteStruct);
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

    async onReady() {
        this.updateInterval = this.config.updateInterval * 1000;   // update interval
        await this.startWindhager();

        this.log.debug('back to on ready');
        this.subscribeStates('*');
/*
        // reset init config after restart
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
            native: {
                fullScan:       false,
                deleteStruct:   false,
                initStruct:     'none',
                importFile:     null
            }
        });
 */
        this.config.fullScan        = false;
        this.config.deleteStruct    = false;
        this.config.initStruct      = 'none';
        delete this.config.importFile;

        this.log.debug('onReady end');
    }

    onUnload(callback) {
        try {
            callback();
        } catch (e) {
            callback();
        }
    }

    async onObjectChange(id, obj) {
        if (obj) {
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            this.log.info(`object ${id} deleted`);
        }
        const objs = Object.entries(this.mapping).filter( ( [oId, sId] ) => (sId = id) );
        //        if (state && !state.ack) {
    }

    async onStateChange(id, state) {
        if (state && !state.ack) {
            try {
                const k = id.split('.');

                const obj   = await this.getObjectAsync(id);
                let   o;
                if(obj && obj.native && obj.native.OID) {
                    o = OId(obj.native.OID);
                }

                if (k[2] == this.windhager.subnet) {
                    await this.writeWindhagerState(id, state);
                    this.setState(id, {val: state.val, ack: true});
                } else if (k[2] === 'trigger_update') {
                    this.log.info('manually trigger update');
                    await this.updateWindhagerData();
                } else if (k[2] === 'trigger_export') {
                    this.log.info('trigger export');
                    await this.export(state.val);
                    this.setState(id, {val: 'done', ack: true});
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
