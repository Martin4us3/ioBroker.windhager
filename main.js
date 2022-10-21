/* eslint-disable no-inner-declarations */
'use strict';

const utils = require('@iobroker/adapter-core');
const http  = require('urllib');

class Windhager extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'windhager',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this._wCon = false;
    }

    set wConnected( con ) {
        if( this._wCon !== con )
            this.setForeignState(`system.adapter.${this.namespace}.connected`, {val: con, ack: true});
        this._wCon=con;
    }

    async requestWindhager( whFunc, options ) {
        const connOptions = {
            method:             'GET',
            rejectUnauthorized: false,
            digestAuth:         this.authentification,
            dataType:           'json'
        };
        if( options ) Object.keys(options).forEach( id => { connOptions[id] = options[id]; });
        try {
            const { data, res } = await http.request(`http://${this.windhagerIP}/api/1.0/${whFunc}`, connOptions);
            if(res.statusCode !== 200) throw (res.statusMessage);
            // connected
            this.wConnected = true;
            return data;
        } catch ( error ) {
            // not connected
            this.wConnected = false;
            throw error;
        }
    }

    async updateDeviceStructure( deleteBefore = false ) {
        // read data from Windhager
        const subnetId  = (await this.requestWindhager('lookup'))[0];
        // delete all channels and states
        if(deleteBefore) {
            const r = this.namespace + '.' + subnetId;
            const params = { startkey: r, endkey: r + '.\u9999' };
            const allChannels   = await this.getObjectViewAsync('system', 'channel', params );
            let   allObjects    = allChannels.rows.reduce( (result, row) => {  result[row.id] = row.value; return result; }
                , {});
            const allStates     = await this.getObjectViewAsync('system', 'state', params );
            allObjects    = allStates.rows.reduce( (result, row) => {  result[row.id] = row.value; return result; }
                , allObjects);
            await Promise.all(
                Object.keys(allObjects).map( id => this.delObjectAsync( id ) )
            );
        }

        const wstruct = await this.requestWindhager('lookup/' + subnetId);
        const fctObjs = wstruct.reduce( (fctObjs, device) => {
            device.functions.reduce( (fctObjs, fct) => {
                if(fct.lock !== undefined && !fct.lock) {
                    if( this.windhagerConfig.function_type[fct.fctType] ) { // known function type
                        fctObjs[`${subnetId}.${device.nodeId}-${fct.fctId}`] = {
                            type: 'device',
                            common: { name: fct.name },
                            native: {
                                fctType: fct.fctType
                            }
                        };
                    }
                }
                return fctObjs;
            }, fctObjs );
            return fctObjs;
        }, {} );
        // add subnet id as root
        const structObjs = {
            [subnetId]: { type: 'folder',
                common: {name: 'System'},
                native: {}
            },
            ...fctObjs};
        // write ioBroker objects
        Object.entries(structObjs).forEach(([id, data]) => {
            this.setObjectNotExistsAsync( id, data );
        });

        // prepare all objs ...channel, states
        this.cache = {
            mapping: {},
            lookup: []
        };
        const objs = {};
        const data      = await this.requestWindhager('datapoints');
        data.forEach( entry => {
            const keys = entry.OID.split('/');
            const deviceId  = `${keys[1]}.${keys[2]}-${keys[3]}`;

            const fctConfig = fctObjs[deviceId] ? this.windhagerConfig.function_type[fctObjs[deviceId].native.fctType] : undefined;
            const fctState  = fctConfig ? fctConfig.state[entry.name] : undefined;
            // is state part of pattern?
            if(fctState === undefined) {
                if(fctObjs[deviceId] && fctObjs[deviceId].native)
                    this.log.warn(`Windhager obj ${entry.OID} unknown, function type: ${fctObjs[deviceId].native.fctType}, entry: ${entry.name}`);
                else
                    this.log.info(`Windhager function ${deviceId} of object ${entry.OID} not found`);
            } else {
                const channelId = `${deviceId}.${fctState.level}`;
                const stateId   = `${channelId}.${entry.name}`;

                // create channel, if needed
                if( !objs[channelId] ) {
                    objs[channelId] = {
                        obj: {
                            type: 'channel',
                            common: { name: fctConfig.level[fctState.level].name },
                            native: {}
                        }
                    };
                }
                // create state
                const state = {
                    type: 'state',
                    common: {
                        name: fctState.name,
                        type: this.windhagerConfig.type[entry.typeId] || 'string',
                        read: true,
                        write: !(fctState.writeProt !== undefined ? fctState.writeProt : entry.writeProt)
                    },
                    native: {
                        OID: entry.OID,
                    }
                };
                if(fctState.lookup) {
                    state.native.lookup = fctState.lookup;
                    this.cache.lookup.push(entry.OID);
                }
                if(entry.unitId && this.windhagerConfig.unit[entry.unitId]) state.common.unit = this.windhagerConfig.unit[entry.unitId];

                function cast ( val ) { return state.common.type === 'number' ? Number(val) : val; }
                if(fctState.minValue || entry.minValue)
                    state.common.min = fctState.minValue ? cast(fctState.minValue) : cast(entry.minValue);
                if(fctState.maxValue || entry.maxValue)
                    state.common.max = fctState.maxValue ? cast(fctState.maxValue) : cast(entry.maxValue);
                if(entry.enum && fctState.enum) {
                    const domain    = fctConfig.enum[fctState.enum];
                    const enums     = entry.enum.substring(1, entry.enum.length - 1).split(',').map(m => Number(m));
                    state.common.states = enums.reduce((states, s) => {
                        if (domain[s]) states[s] = domain[s];
                        return states;
                    }, {});
                }
                objs[stateId] = {
                    obj: state,
                    val: cast(entry.value)
                };
                this.cache.mapping[entry.OID] = stateId;
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

        await this.setObjectNotExistsAsync('info.mapping', {
            type: 'state',
            common: {
                name: 'mapping',
                desc: 'mapping of Windhager and ioBroker states',
                type: 'json',
                role: 'config',
                read: true,
                write: false
            },
            native: {}
        });
        this.setState('info.mapping', { val: JSON.stringify(this.cache.mapping), ack: true });
    }

    async readMapping( ) {
        const params    = { startkey: this.namespace, endkey: this.namespace + '.\u9999' };
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
            const   OIDs = updateAll ? Object.keys(this.cache.mapping) : this.cache.lookup;
            const   blockSize = 25; const start = Date.now();
            let     count = 0;

            for( let i = 0; i <= OIDs.length / blockSize; i++ ) {
                const block = OIDs.slice( i*blockSize, (i+1)*blockSize );
                await Promise.all( block.map( OID => {
                    return this.requestWindhager('datapoint' + OID ).then( o => {
                        this.setState(this.cache.mapping[o.OID], {val: this.windhagerConfig.type[o.typeId] === 'number' ? Number(o.value) : o.value, ack: true});
                        count++;
                    }).catch( err => this.log.warn(`can not read ${OID} from Windhager; Error: ${err}`) );
                }));
            }
            this.log.info(`update ${count} Windhager states in ${Date.now()-start} milliseconds`);
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
        // Windhager address and access
        this.windhagerIP        = this.config.ip;
        this.authentification   = `${this.config.login}:${this.config.password}`;
        this.connected          = false;
        http.agent.keepAlive    = true;

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

        // Windhager state configuration
        const configStateId = 'windhager.admin.windhager-config';
        const configState = await this.getForeignStateAsync(configStateId);
        if( configState && configState.val !== '' ) {
            this.windhagerConfig = JSON.parse(configState.val);
        } else {
            this.windhagerConfig    = require('./lib/windhager-config.json');
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
                this.setForeignState(configStateId, {val: JSON.stringify(this.windhagerConfig), ack: true});
            });
        }

        // cache for pattern and state
        if(reloadStructure) {
            await this.updateDeviceStructure(deleteStructure);
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
                const obj = await this.getObjectAsync( id );
                const c = obj.common;
                // validate
                let valErr = undefined;
                if( !c.write )                                  valErr = 'state is write protected';
                else if( c.type !== typeof state.val )          valErr = 'wrong state type';
                else if( c.states && !c.states[state.val] )     valErr = 'wrong enum entry';
                else if( c.min && state.val < c.min )           valErr = 'value smaller then min value';
                else if( c.max && state.val > c.max )           valErr = 'value smaller then min value';

                if( valErr ) {
                    this.log.error(`state cannot set: ${ valErr }`);
                } else {
                    const options = {
                        method: 'PUT',
                        data:   JSON.stringify({ OID: obj.native.OID, value: String(state.val) })
                    };
                    await this.requestWindhager( 'datapoint', options );
                    this.setState(id, { val: state.val, ack: true });
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
