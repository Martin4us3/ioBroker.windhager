/* eslint-disable no-inner-declarations */
'use strict';

const utils = require('@iobroker/adapter-core');
const http  = require('urllib');

function OId( oid ) {
    const k = oid.split('/');
    const n1 = new Intl.NumberFormat('en', {minimumIntegerDigits: 2}).format(k[4]);
    const n2 = new Intl.NumberFormat('en', {minimumIntegerDigits: 3}).format(k[5]);
    return {
        oid:        oid,
        subnetId:   k[1],
        deviceId:   `${k[1]}.${k[2]}`,
        fctId:      `${k[1]}.${k[2]}-${k[3]}`,
        name:       `${n1}-${n2}`
    };
}

class WindhagerDevice {
    constructor( config, ip, user, password) {
        this.config             = config;
        this.ip                 = ip;
        this.authentification   = `${user}:${password}`;
    }

    datapointConfig( oId ) {
        const fct   = this.fct[oId.fctId];
        if (!fct)
            throw new Error(`unknown Windhager function id ${oId.fctId}`);
        const fctConfig = this.config.function_type[fct.fctType];
        if (!fctConfig)
            throw new Error(`config for Windhager function type ${fct.fctType} not available`);
        const dpConfig = fctConfig.state[oId.name];
        if (!dpConfig)
            throw new Error(`Windhager datapoint config for ${oId.name} not available in function type ${oId.fctType}`);
        return {fctConfig, dpConfig};
    }

    async init() {
        this.httpClient                 = http.create();
        this.httpClient.agent.keepAlive = true;

        this.subnetId                   = (await this.request('lookup'))[0];

        const struct = await this.request('lookup/' + this.subnetId);
        this.fct = struct.reduce( (fctObjs, device) => {
            device.functions.reduce( (fctObjs, fct) => {
                if(fct.lock !== undefined && !fct.lock) {
                    if( this.config.function_type[fct.fctType] ) { // known function type
                        fctObjs[`${this.subnetId}.${device.nodeId}-${fct.fctId}`] = {
                            name: fct.name,
                            fctType: fct.fctType
                        };
                    }
                }
                return fctObjs;
            }, fctObjs );
            return fctObjs;
        }, {} );
    }

    async request(whFunc, options) {
        const connOptions = {
            method: 'GET',
            rejectUnauthorized: false,
            digestAuth: this.authentification,
            dataType: 'json'
        };
        if (options) Object.keys(options).forEach(id => {
            connOptions[id] = options[id];
        });
        const {data, res} = await this.httpClient.request(`http://${this.ip}/api/1.0/${whFunc}`, connOptions);
        if (res.statusCode !== 200) throw (res.statusMessage);
        return data;
    }

    async putDatapoint( oId, val ) {
        const options = {
            method: 'PUT',
            data:   JSON.stringify({ OID: oId, value: typeof val === 'string' ? val : String(val) })
        };
        return this.request( 'datapoint', options );
    }
    async getDatapoint( OId ) {
        return this.request('datapoint' + OId );
    }
    async getDatapoints( OIds ) {
        if( OIds ) {
            const   blockSize = 10;
            const   datapoints = [];
            for( let i = 0; i <= OIds.length / blockSize; i++ ) {
                const block = OIds.slice( i*blockSize, (i+1)*blockSize );
                await Promise.all( block.map( OId => {
                    return this.request('datapoint' + OId ).then( dp => {
                        datapoints.push(dp);
                    });
                }));
            }
            return datapoints;
        } else {
            return this.request('datapoints' );
        }
    }
}

class Windhager extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'windhager',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    set wConnected( con ) {
        if( this._wCon !== con )
            this.setForeignState(`system.adapter.${this.namespace}.connected`, {val: con, ack: true});
        this._wCon = con;
    }

    async getWindhagerConfig() {
        // Windhager state configuration
        const configStateId = 'windhager.admin.windhager-config';
        const configState   = await this.getForeignStateAsync(configStateId);
        if( configState && configState.val !== '' ) {
            return JSON.parse(configState.val);
        } else {
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
            }).then( () => {
                this.setForeignState(configStateId, {val: JSON.stringify(config), ack: true});
            });
            return config;
        }
    }

    createStateObj( { oId, dp, id, obj } ) {
        const {fctConfig, dpConfig} = this.windhager.datapointConfig(OId( oId || dp.OID ));
        const common = {
            name: obj && obj.common.name ? obj.common.name : dpConfig.name,
            type: (dp && this.windhager.config.type[dp.typeId]) ? this.windhager.config.type[dp.typeId] : 'string',
            read: true,
            write: !(dpConfig.writeProt !== undefined ? dpConfig.writeProt : (dp ? dp.writeProt : true))
        };
        // Unit
        if (dp && dp.unitId && this.windhager.config.unit[dp.unitId])
            common.unit = this.windhager.config.unit[dp.unitId];

        // validation
        function cast(val) {
            return common.type === 'number' ? Number(val) : val;
        }

        if (dpConfig.minValue || (dp && dp.minValue))
            common.min = dpConfig.minValue ? cast(dpConfig.minValue) : cast(dp.minValue);
        if (dpConfig.maxValue || (dp && dp.maxValue))
            common.max = dpConfig.maxValue ? cast(dpConfig.maxValue) : cast(dp.maxValue);
        if (dp && dp.enum && dpConfig.enum) {
            const domain = fctConfig.enum[dpConfig.enum];
            const enums = dp.enum.substring(1, dp.enum.length - 1).split(',').map(m => Number(m));
            common.states = enums.reduce((states, s) => {
                if (domain[s]) states[s] = domain[s];
                return states;
            }, {});
        }

        const native = {};
        if (dp && dp.OID) native.OID = dp.OID;
        if (dpConfig.lookup) native.lookup = dpConfig.lookup;

        // cache
        this.cache.mapping[oId] = id;
        if (native.lookup) this.cache.lookup.push(oId);

        // create state
        const stateObj = {
            obj: {
                type:   'state',
                common: common,
                native: native
            }
        };
        if(dp && dp.value) stateObj.val = (common.type === 'number' ? Number(dp.value) : dp.value);

        return stateObj;
    }

    createStateObjOld( dp, dpConfig, fctConfig ) {
        if(dp === undefined) {
            dp = {};
        }

        // create state
        const state = {
            type: 'state',
            common: {
                name: dpConfig.name,
                type: this.windhager.config.type[dp.typeId] || 'string',
                read: true,
                write: !(dpConfig.writeProt !== undefined ? dpConfig.writeProt : dp.writeProt)
            },
            native: {
                OID: dp.OID
            }
        };
        // lookup group
        if(dpConfig.lookup)  state.native.lookup = dpConfig.lookup;
        // Unit
        if(dp.unitId && this.windhager.config.unit[dp.unitId]) state.common.unit = this.windhager.config.unit[dp.unitId];
        // validation
        function cast ( val ) { return state.common.type === 'number' ? Number(val) : val; }
        if(dpConfig.minValue || dp.minValue)
            state.common.min = dpConfig.minValue ? cast(dpConfig.minValue) : cast(dp.minValue);
        if(dpConfig.maxValue || dp.maxValue)
            state.common.max = dpConfig.maxValue ? cast(dpConfig.maxValue) : cast(dp.maxValue);
        if(dp.enum && dpConfig.enum) {
            const domain    = fctConfig.enum[dpConfig.enum];
            const enums     = dp.enum.substring(1, dp.enum.length - 1).split(',').map(m => Number(m));
            state.common.states = enums.reduce((states, s) => {
                if (domain[s]) states[s] = domain[s];
                return states;
            }, {});
        }
        return state;
    }

    async deleteAllStates() {
        const r = this.namespace + '.' + this.windhager.subnetId;
        const params = { startkey: r, endkey: r + '.\u9999' };
        const o      = await this.getObjectViewAsync('windhager', 'subnetObjects', params );
        const allObjects = o.rows.reduce( (result, row) => {  result[row.id] = row.value; return result; },{});
        await Promise.all(
            Object.keys(allObjects).map( id => this.delObjectAsync( id ) )
        );
        this.cache = {
            mapping: {},
            lookup: []
        };
    }

    validateStateValue(id, state, obj) {
        const c = obj.common;
        let valErr = undefined;

        if( !c.write )                                  valErr = 'state is write protected';
        else if( c.type !== typeof state.val )          valErr = 'wrong state type';
        else if( c.states && !c.states[state.val] )     valErr = 'wrong enum entry';
        else if( c.min && state.val < c.min )           valErr = 'value smaller then min value';
        else if( c.max && state.val > c.max )           valErr = 'value smaller then min value';
        return valErr;
    }

    async writeWindhagerState(id, state) {
        const obj = await this.getObjectAsync( id );
        const err = this.validateStateValue(id, state, obj);
        if( err ) {
            throw `state cannot set: ${ err }`;
        } else {
            await this.windhager.putDatapoint(obj.native.OID, state.val);
            this.setState(id, { val: state.val, ack: true });
        }
    }

    async importDeviceStructure( deleteBefore = false ) {
        try {
            // delete all channels and states
            if (deleteBefore) await this.deleteAllStates();
            // import
            const imp = JSON.parse((await this.getStateAsync(this.namespace + '.config')).val);
            // datapoint for detail config
            const dps = (await this.windhager.getDatapoints()).reduce((dps, dp) => {
                dps[dp.OID]=dp;
                return dps;
            }, {});
            // Windhager function for pattern
            const fctByType = Object.entries(this.windhager.fct).reduce( ( fbt, [id, fct] ) => {
                if(!fbt[fct.fctType]) fbt[fct.fctType] = [];
                fbt[fct.fctType].push(id);
                return fbt;
            }, {});

            const objs = Object.entries(imp).reduce( (objs, [id,obj ]) => {
                const mFctType = id.match(/%(\d+)/);
                if(mFctType) {
                    const fctType = mFctType[1];
                    if(obj.type === 'state' && !(obj.native && obj.native.OID)) {
                        this.log.error(`OID missing for import pattern `);
                    } else {
                        fctByType[fctType].forEach(fctId => {
                            const nId = id.replace(/%\d+/, this.namespace + '.' + fctId);
                            try {
                                if (obj.type === 'state') {
                                    const oId = obj.native.OID.replace(/%\d+/, '/'+fctId.replace(/[./-]/g, '/'));
                                    objs[nId] = this.createStateObj( {
                                        oId: oId,
                                        dp: dps[oId],
                                        id: nId,
                                        obj: obj
                                    });
                                } else {
                                    if( obj.type === 'device' ) {
                                        const common    = Object.assign({}, obj.common);
                                        common.name     = this.windhager.fct[fctId].name;
                                        objs[nId]       = { obj: { type: obj.type, common: common, native: obj.native }};
                                    } else {
                                        objs[nId] = { obj: obj };
                                    }
                                }
                            } catch( e ) {
                                this.log.error(`cannot create import state ${nId}`);
                            }
                        });
                    }
                } else {
                    const nId = this.namespace + id;
                    if(obj.type==='state') {
                        if(obj.native && obj.native.OID) {
                            objs[ nId ] = this.createStateObj({
                                oId:    obj.native.OID,
                                dp:     dps[obj.native.OID],
                                id:     nId,
                                obj:    obj
                            });
                        } else
                            this.log.error(`OID missing for import pattern `);
                    } else
                        objs[ nId ] = { obj: obj };
                }
                return objs;
            }, {} );
            Object.entries(objs).forEach(([id, data]) => {
                this.setObjectNotExistsAsync( id, data.obj ).then( () => {
                    if(data.val) this.setState(id, {val: data.val, ack: true});
                } );
            });
        } catch (e) {
            this.log.error(`error during import of state structure: ${e.message}`);
        }
    }

    async updateDeviceStructure( deleteBefore = false ) {
        // delete all channels and states
        if(deleteBefore) await this.deleteAllStates();

        // default root and Windhager fct objects
        const structObjs = {
            [this.windhager.subnetId]: {
                type: 'folder',
                common: {name: 'System'},
                native: {}
            },
            ... Object.entries(this.windhager.fct).reduce( (objs, [id, fct] )=>{
                objs[id] = {
                    type:   'device',
                    common: {name: fct.name},
                    native: {fctType: fct.fctType}
                };
                return objs;
            }, {})
        };
        // write ioBroker objects
        Object.entries(structObjs).forEach(([id, data]) => {
            this.setObjectNotExistsAsync( id, data );
        });

        // prepare all objs ...channel, states
        const objs = {};
        const data = await this.windhager.request('datapoints');
        data.forEach( entry => {
            try {
                const oId       = OId(entry.OID);
                const {fctConfig, dpConfig} = this.windhager.datapointConfig( oId );
                const channelId = `${oId.fctId}.${dpConfig.level}`;
                const stateId   = `${channelId}.${oId.name}`;

                // create channel, if needed
                if( !objs[channelId] ) {
                    objs[channelId] = {
                        obj: {
                            type: 'channel',
                            common: { name: fctConfig.level[dpConfig.level].name },
                            native: {}
                        }
                    };
                }
                // state
                objs[stateId] = this.createStateObj( { dp: entry, id: stateId });
            } catch ( err ) {
                this.log.warn(err.message);
            }
        });

        // sort and write all objects
        const ordered = Object.keys(objs).sort().reduce(
            (obj, key) => { obj[key] = objs[key]; return obj; }, {}
        );
        Object.entries(ordered).forEach(([id, data]) => {
            this.setObjectNotExistsAsync( id, data.obj ).then( () => {
                if(data.val) this.setState(id, {val: data.val, ack: true});
            } );
        });
    }

    async readMapping( ) {
        const r = this.namespace + '.' + this.windhager.subnetId;
        const params = { startkey: r, endkey: r + '.\u9999' };
        const allStates = await this.getObjectViewAsync('system', 'state', params );
        this.cache = allStates.rows.reduce( (result, row) => {
            if(row.value.native && row.value.native.OID) {
                result.mapping[row.value.native.OID] = row.id.substring(this.namespace.length+1, row.id.length);
                if(row.value.native.lookup) result.lookup.push(row.value.native.OID);
            }
            return result;
        }, { mapping: {}, lookup: [] });
    }

    async updateWindhagerData( updateAll = false ) {
        try {
            const start = Date.now();
            const dps = await this.windhager.getDatapoints( );//updateAll ? undefined :this.cache.lookup );
            dps.forEach( dp => {
                const id = this.cache.mapping[dp.OID];
                if(id)
                    this.setState(id, {val: this.windhager.config.type[dp.typeId] === 'number' ? Number(dp.value) : dp.value, ack: true});
            });
            this.log.debug(`update ${dps.length} Windhager states in ${Date.now()-start} milliseconds`);

/*
            const   OIDs = updateAll ? Object.keys(this.cache.mapping) : this.cache.lookup;
            const   blockSize = 10; const start = Date.now();
            let     count = 0;
            for( let i = 0; i <= OIDs.length / blockSize; i++ ) {
                const block = OIDs.slice( i*blockSize, (i+1)*blockSize );
                await Promise.all( block.map( OID => {
                    return this.windhager.request('datapoint' + OID ).then( o => {
                        this.setState(this.cache.mapping[o.OID], {val: this.windhager.config.type[o.typeId] === 'number' ? Number(o.value) : o.value, ack: true});
                        count++;
                    }).catch( err => this.log.warn(`can not read ${OID} from Windhager; Error: ${err}`) );
                }));
            }
            this.log.info(`update ${count} Windhager states in ${Date.now()-start} milliseconds`);
*/
        } catch ( error ) {
            this.log.error(`error: ${error}`);
        }
    }

    async intervalUpdate() {
        await this.updateWindhagerData( (this.lookup.counter >= this.lookup.multiplier) );
        if(this.lookup.counter >= this.lookup.multiplier)
            this.lookup.counter = 0;
        else
            this.lookup.counter++;

        this.timeout = setTimeout(() => {
            this.intervalUpdate();
        }, this.lookup.interval );
    }

    async onReady() {
        // Windhager
        this.windhager = new WindhagerDevice(await this.getWindhagerConfig(), this.config.ip, this.config.login, this.config.password);
        await this.windhager.init();

        // update interval
        if(this.config.lookupIntervalAll % this.config.lookupInterval !== 0) {
            this.config.lookupIntervalAll = this.config.lookupInterval *
                                Math.round(this.config.lookupIntervalAll / this.config.lookupInterval);
            this.extendForeignObjectAsync(`system.adapter.${this.namespace}`,
                {native: {lookupIntervalAll: this.config.lookupIntervalAll}});
        }
        this.lookup = {
            interval:       this.config.lookupInterval * 1000,                                  // in seconds
            multiplier:     this.config.lookupIntervalAll / this.config.lookupInterval,
            counter:        0
        };

        // reload structure on startup
        const reloadStructure   = this.config.reloadStructure;
        const deleteStructure   = this.config.deleteStructure;
        if(this.config.reloadStructure || this.config.deleteStructure) { // reset params
            this.extendForeignObjectAsync(`system.adapter.${this.namespace}`,
                {native: {reloadStructure: false, deleteStructure: false}});
        }

        // cache for pattern and state
        if(reloadStructure) {
            await this.updateDeviceStructure( deleteStructure );
        } else {
            await this.readMapping();
        }

        this.subscribeStates('*');
        await this.intervalUpdate();
    }

    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (state && !state.ack) {
            try {
                const k = id.split('.');
                // noinspection EqualityComparisonWithCoercionJS
                if(k[2] == this.windhager.subnetId) {
                    await this.writeWindhagerState(id, state);
                    this.setState(id, { val: state.val, ack: true });
                } else if(k[2] === 'trigger_update') {
                    this.log.info('manually trigger update');
                    await this.updateWindhagerData();
                } else if(k[2] === 'trigger_export') {
                    this.log.info('export Windhager model');
                    await this.exportModel(true );
                } else if(k[2] === 'trigger_import') {
                    this.log.info('import Windhager model');
                    await this.importDeviceStructure(true);
                }
            } catch ( error ) {
                this.log.error(`Error ${ error }`);
            }
        }
    }

    async exportModel( generic = true ) {
        const r          = this.namespace + '.' + this.windhager.subnetId;
        // regExp to replace pattern
        const rExpIdStr  = r.replace(/\./g, '\\.');
        const rExpId     = new RegExp(rExpIdStr+'\\.\\d+-\\d+', '');
        // read objects
        const params = { startkey: r, endkey: r + '.\u9999' };
        const view   = await this.getObjectViewAsync('windhager', 'subnetObjects', params );
        // generate export
        const objs = view.rows.reduce( (result, {id, value}) => {
            if( generic ) {
                const i = id.split('.');
                const fctType = this.windhager.fct[i[2]+'.'+i[3]].fctType;
                id = id.replace(rExpId, `%${fctType}`);
                if(value.native && value.native.OID) {
                    value.native.OID = value.native.OID.replace(/\/\d+\/\d+\/\d+/, `%${fctType}`);
                }
            } else {
                // regExp to replace pattern
                id = id.replace(new RegExp(this.namespace.replace(/\./g, '\\.')), '');
            }
            // pattern could already exist - use first
            if(!result[id]) {
                result[id] = {
                    type:   value.type,
                    common: {name: value.common.name},
                    native: value.native
                };
            }
            return result;
        },{});
        // write in state
        const e = this.namespace + '.export';
        await this.setObjectNotExistsAsync( e, {
            type: 'state',
            common: {name: 'export', desc: 'result of model export', type: 'json', read: true},
            native:{}
        } );
        this.setState(e, {val: JSON.stringify(objs), ack: true});
    }
}

if (module.parent) {
    module.exports = (options) => new Windhager(options);
} else {
    new Windhager();
}
