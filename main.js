/* eslint-disable no-inner-declarations */
'use strict';

const utils         = require('@iobroker/adapter-core');
//const axios         = require('axios-digest');
const http          = require('urllib');
//const xmlConvert    = require('xml-js');

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

    // http://192.168.110.145/res/xml/EbenenTexte_de.xml
    // http://192.168.110.145/res/xml/VarIdentTexte_de.xml
    // http://192.168.110.145/res/xml/AufzaehlTexte_de.xml
    // http://192.168.110.145/res/xml/ErrorTexte_de.xml
/*
    apiURLPath = "/api/1.0/lookup" # return a realtime value (slow)
    apiURLCachePath = "/api/1.0/datapoint" # return  a 30 sec cached value
    apiURLFullCachePath = "/api/1.0/datapoints" # return every cached values
*/

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

    async request(whFunc, options) {
        const connOptions = {
            method:             'GET',
            timeout:            10000,
            timing:             true,
  //          agent:              this.agent,
            rejectUnauthorized: false,
            digestAuth:         this.authentification,
            dataType:           'json'
        };
        if (options) Object.keys(options).forEach(id => {
            connOptions[id] = options[id];
        });
        const {data, res} = await this.httpClient.request(`http://${this.ip}/api/1.0/${whFunc}`, connOptions);
        if (res.statusCode !== 200) {
            new Error(res.statusMessage);
        }
        return data;
    }

    async init() {
        this.httpClient = http.create();
        this.httpClient.agent.keepAlive = true;

        this.subnetId   = (await this.lookup())[0];
        const struct    = await this.lookup('/' + this.subnetId);
        this.fct = struct.reduce( (fctObjs, device) => {
            device.functions.reduce( (fctObjs, fct) => {
                if( fct.fctType >= 0 && this.config.function_type[fct.fctType] ) { // known function type
                    fctObjs[`${this.subnetId}.${device.nodeId}-${fct.fctId}`] = {
                        name:       fct.name,
                        fctType:    fct.fctType
                    };
                }
                return fctObjs;
            }, fctObjs );
            return fctObjs;
        }, {} );
        // todo: read structure from Windhager resources
        /*
        const connOptions = {
            method: 'GET',
            rejectUnauthorized: false,
            digestAuth: this.authentification,
            dataType: 'text'
        };
        const {data, res} = await this.httpClient.request(`http://${this.ip}/res/xml/VarIdentTexte_de.xml`, connOptions );
        const xmlData = xmlConvert.xml2js(data, { compact : true})
        this.varIdentText = xmlData.VarIdentTexte.gn.reduce( (objs, o) => {
            if(Array.isArray(o.mn)) {
                objs[o._attributes.id] = o.mn.reduce( (text, t) => {
                    text[t._attributes.id] = t._text;
                    return text;
                }, {} );
            } else {
                objs[o._attributes.id] = {[o.mn._attributes.id]: o.mn._text};
            }
            return objs;
        }, {} );
*/    }

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
    async lookup( OId ) {
        return this.request('lookup' + OId );
    }
    async getDatapoints() {
        // get cached Datepoints
        return this.request('datapoints' );
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

    async setConnected( con ) {
        if( this._wCon !== con ) {
            await this.setForeignStateAsync(`system.adapter.${this.namespace}.connected`, {val: con, ack: true});
        }
        this._wCon = con;
    }

    async getWindhagerConfig() {
        // Windhager state configuration
        const configStateId = 'system.adapter.windhager.state-config';
        const configState   = await this.getForeignStateAsync(configStateId);

        if( configState && configState.val !== '' ) {
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

        // cache
        this.cache.mapping[oId] = id;

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

    async importDeviceStructure( imp, deleteBefore = false ) {
        // datapoint for detail config
        const dps = (await this.windhager.getDatapoints()).reduce((dps, dp) => {
            dps[dp.OID]=dp;
            return dps;
        }, {});

        try {
            // delete all channels and states
            if (deleteBefore) await this.deleteAllStates();

            // initialize new state structure
            let objs;
            if(imp.type === 'flat') {
                objs = Object.entries(imp.states).reduce( (objs, [id,obj ]) => {
                    try {
                        const nId = this.namespace + '.' + id;
                        if(obj.type==='state') {
                            if(obj.native && obj.native.OID) {
                                objs[ nId ] = this.createStateObj({
                                    oId:    obj.native.OID,
                                    dp:     dps[obj.native.OID],
                                    id:     nId,
                                    obj:    obj
                                });
                            } else
                                this.log.error(`OID missing in import state ${id}`);
                        } else
                            objs[ nId ] = { obj: obj };
                    } catch (e) {
                        this.log.error(`error importing object ${id}: ${e.message}`);
                    }
                    return objs;
                }, {} );
            } else if(imp.type === 'struct') {
                objs = Object.entries(this.windhager.fct).reduce( (sObjs, [id,obj]) => {
                    const fctId =  id;
                    const fctType = obj.fctType;
                    if(fctType && imp.fctType[fctType]) {
                        sObjs[ this.namespace + '.' + fctId ] = { obj: {
                            'type': 'device',
                            'common': {
                                'name': obj.name
                            },
                            'native': {
                                'fctType': fctType
                            }
                        } };
                        sObjs = Object.entries(imp.fctType[fctType]).reduce((fObjs, [id,obj]) => {
                            try {
                                const stateId = this.namespace + '.' + fctId + '.' + id;
                                if(obj.type === 'state') {
                                    if(obj.native && obj.native.OID) {
                                        const OId = `/${fctId.replace(/\.|-/g, '/')}${obj.native.OID}`;
                                        fObjs[ stateId ] = this.createStateObj({
                                            oId:    OId,
                                            dp:     dps[OId],
                                            id:     stateId,
                                            obj:    obj
                                        });
                                    } else
                                        this.log.error(`OID missing in import state ${id}`);
                                } else
                                    fObjs[ stateId ] = { obj: obj };
                            } catch (e) {
                                this.log.error(`error importing object ${id} of fctType ${fctType}: ${e.message}`);
                            }
                            return fObjs;
                        }, sObjs );
                    }
                    return sObjs;
                }, {} );
            } else {
                throw new Error(`unknown import type ${imp.type}`)
            }

            Object.entries(objs).forEach(([id, data]) => {
                this.setObjectNotExistsAsync( id, data.obj ).then( () => {
                    if(data.val) this.setState(id, {val: data.val, ack: true});
                } );
            });
            this.log.info(`${Object.keys(objs).length} states created`);
        } catch (e) {
            this.log.error(`error during import of state structure: ${e.message}`);
        }
    }

    async initDeviceStructure( deleteBefore = false ) {
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

        // prepare all objs ...channel, states
        const objs = {};
        const data = await this.windhager.getDatapoints();
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

        // write function objects
        Object.entries(structObjs).forEach(([id, data]) => {
            this.setObjectNotExistsAsync( id, data );
        });

        // sort and write all state objects
        const ordered = Object.keys(objs).sort().reduce(
            (obj, key) => { obj[key] = objs[key]; return obj; }, {}
        );
        Object.entries(ordered).forEach(([id, data]) => {
            this.setObjectNotExistsAsync( id, data.obj ).then( () => {
                if(data.val) this.setState(id, {val: data.val, ack: true});
            } );
        });
        this.log.info(`${Object.keys(ordered).length} states created`);
    }

    async readMapping( ) {
        const allStates = await this.getObjectViewAsync( 'windhager', 'subnetStates', { startkey: '', endkey: '\u9999' } );
        this.cache = allStates.rows.reduce( (result, row) => {
            if(row.value.native && row.value.native.OID) {
                result.mapping[row.value.native.OID] = row.id.substring(this.namespace.length+1, row.id.length);
            }
            return result;
        }, { mapping: {} });
    }

    async updateWindhagerData( ) {
        const start = Date.now(); let count = 0;
        const dps = Object.keys(this.cache.mapping);
        for(let i = 0; i<dps.length; i++) {
            try {
                const dp = await this.windhager.lookup(dps[i]);
                const id = this.cache.mapping[dp.OID];
                if(id) {
                    this.setState(id, {val: this.windhager.config.type[dp.typeId] === 'number' ? Number(dp.value) : dp.value, ack: true});
                    count++;
                }
            } catch (e) {
                this.log.warn(`haven't got value for datapoint ${dps[i]}; error: ${e.message}`);
            }
        }
        this.log.debug(`update ${count} Windhager states in ${Date.now()-start} milliseconds` +
            ((count < this.cache.mapping.length) ? `; ${this.cache.mapping.length - count} loosed` : ''));
    }

    async intervalUpdate() {
        await this.updateWindhagerData( );
        this.timeout = setTimeout(() => {
            this.intervalUpdate();
        }, this.updateInterval );
    }

    async startWindhager( ) {
        try {
            this.log.debug('try to connect to Windhager...');

            this.connectTries++;
            this.windhager = new WindhagerDevice(await this.getWindhagerConfig(), this.config.ip, this.config.login, this.config.password);
            await this.windhager.init();

            await this.setConnected( true );

            this.log.info('Windhager connected');

            this.cache = {
                mapping: {},
            };

            if(this.initStructConfig && this.initStructConfig.cmd && this.initStructConfig.cmd !== 'none' ) {
                this.log.debug('initialize state structure...');
                if(this.initStructConfig.cmd === 'import')
                    await this.importDeviceStructure( this.initStructConfig.obj, this.initStructConfig.delete );
                else if(this.initStructConfig.cmd === 'default')
                    await this.importDeviceStructure( this.windhager.config["default-struct"], this.initStructConfig.delete );
                else if(this.initStructConfig.cmd === 'windhager')
                    await this.initDeviceStructure( this.initStructConfig.delete );
            } else {
                await this.readMapping();
            }

            this.log.info('start regular update of states');
            await this.intervalUpdate();
        } catch( e ) {
            await this.setConnected(false);
            delete this.windhager;

            let stopProcess = true;
            if( e.name && e.name === "JSONResponseFormatError" ) {
                if( e.status === 401 ) {
                    this.log.error('wrong user/password for Windhager - adapter disabled');
                } else if(e.status === 'xxx') {
                    if( this.connectTries < 5 ) {
                        this.log.error('timeout trying to connect Windhager... try again in 5 min. - ' + e.message);
                        this.timeout = setTimeout(() => {
                            this.startWindhager( );
                        }, 5 * 60 * 1000 );
                        stopProcess = false;
                    } else {
                        this.log.error('could not connect to Windhager... adapter stopped' + e.message);
                    }
                }
            }
            if(stopProcess) {
                await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {common: { enabled: false }});
                this.stop();
            }
        }
    }

    async onReady() {
        // update interval
        this.updateInterval   = this.config.updateInterval * 1000;
        this.initStructConfig = this.config.initStruct;                                 // this.getInitStructureConfig(this.config.initStruct);

        this.connectTries = 0;
        await this.startWindhager( );
        this.subscribeStates('*');

        if( !this.config.initStruct || this.config.initStruct.cmd !== 'none' )          // initialize after restart only once
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {native: { initStruct: {cmd: 'none', obj: null, delete: false} } });
    }

    onUnload(callback) {
        try {
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
                }
            } catch ( error ) {
                this.log.error(`Error ${ error }`);
            }
        }
    }
}

if (module.parent) {
    module.exports = (options) => new Windhager(options);
} else {
    new Windhager();
}
