/* eslint-disable no-inner-declarations */
'use strict';

const {request}     = require('urllib');
const xmlConvert    = require('xml-js');

function OId( oidStr ) {
    function formatName(groupNr, memberNr) {
        const gr = new Intl.NumberFormat('en', {minimumIntegerDigits: 2}).format(groupNr);
        const me = new Intl.NumberFormat('en', {minimumIntegerDigits: 3}).format(memberNr);
        return `${gr}-${me}`;
    }
    const k = oidStr.split('/');
    return {
        OID:        oidStr,
        subnet:     Number(k[1]),
        fctId:      `${k[2]}-${k[3]}`,
        groupNr:    Number(k[4]),
        memberNr:   Number(k[5]),
        ext:        Number(k[6]),
        name:       formatName(k[4], k[5])
    }
}

class WindhagerDevice {
    constructor(config, log, ip, lang = 'de') {
        this.config = config;
        this.log    = log;
        this.ip     = ip;
        this.lang   = lang;
    }
    /*
        apiURLPath = "/api/1.0/lookup"              # return a realtime value (slow)
        apiURLCachePath = "/api/1.0/datapoint"      # return  a 30 sec cached value
        apiURLFullCachePath = "/api/1.0/datapoints" # return every cached values
    */
    async request(whFunc, options) {
        const connOptions = {
            method: 'GET',
            timeout: 10000,
            rejectUnauthorized: false,
            digestAuth: this.authentification,
            dataType: 'json'
        };
        if (options) Object.keys(options).forEach(id => {
            connOptions[id] = options[id];
        });
        this.log.silly(`Windhager request "${`http://${this.ip}/api/1.0/${whFunc}`}" options: ${JSON.stringify(connOptions)}`);
        const {data, res} = await request(`http://${this.ip}/api/1.0/${whFunc}`, connOptions);
        this.log.silly('Windhager request result ' + JSON.stringify(res));

        if (res.statusCode !== 200) {
            this.log.info('Windhage request exeption ');
            new Error(res.statusMessage);
        }
        return data;
    }

    async lookup(oId) {
        return this.request('lookup' + (oId || ''));
    }

    async putDatapoint(oId, val) {
        const options = {
            method: 'PUT',
            data: JSON.stringify({OID: oId, value: typeof val === 'string' ? val : String(val)})
        };
        return this.request('datapoint', options);
    }

    async getDatapoint(OId) {
        return this.request('datapoint' + OId);
    }

    async getDatapoints() {
        // get cached Datepoints
        return this.request('datapoints');
    }

    async logIn( user, password ) {
        this.authentification = `${user}:${password}`;
        this.subnet = (await this.lookup())[0];
        return this.subnet;
    }

    // Resources
    /*
        `/res/xml/VarIdentTexte_${language}.xml`
        `/res/xml/EbenenTexte_${language}.xml`
        `/res/xml/AufzaehlTexte_${language}.xml`
        `/res/xml/ErrorTexte_${language}.xml`
    */
    async resRequest(resTag, lang = 'de') {
        const connOptions = {
            method: 'GET',
            timeout: 10000,
            rejectUnauthorized: false,
            digestAuth: this.authentification,
            dataType: 'text'
        };
        const {data, res} = await request(`http://${this.ip}/res/xml/${resTag}_${lang}.xml`, connOptions);
        if (res.statusCode === 200) {
            try {
                // recursive scan of xml date
                function recur(o) {
                    if (o.elements) {
                        if ((o.elements.length === 1) && (o.elements[0].type === 'text'))  {
                            // lowest level -> member text for var, level or enum
                            return {id: o.attributes.id, o: o.elements[0].text};
                        } else {
                            // element-array
                            const ro = o.elements.reduce((p, e) => { const {id, o} = recur(e); p[id] = o; return p;}, {});
                            return o.attributes.id ? {id: o.attributes.id, o: ro} : ro
                        }
                    } else if(o.name === 'error') { // error codes
                        return {id: o.attributes.code, o: o.attributes.text};
                    } else  { // empty object
                        return { id: o.attributes.id };
                    }
                }
                const jsonData = xmlConvert.xml2js(data);
                return recur(jsonData.elements[1]);
            } catch (e) {
                // todo: log info
            }
        }
    }

    getDpName( groupNr, memberNr ) {
        const gr = this._dpNames[groupNr];
        if(gr) return gr[memberNr];
    }

    getLevelName(fctType, id) {
        const ft = this._levelNames[fctType];
        if(ft) return ft[id];
    }

    getEnumNames( groupNr, memberNr, possible ) {
        const gr = this._enumNames[groupNr];
        if(gr) {
            const en = gr[memberNr];
            if (en && possible)
                return possible.reduce((r, id) => {
                    r[id] = en[id];
                    return r;
                }, {});
            else
                return en;
        }
    }

    getKnownDp( oId ) {
        if(this.knownDPs)
            return this.knownDPs[oId]
        else {
            const id = OId(oId);
            const fctType = this.fct[id.fctId].fctType;
            const dp = Object.assign({}, this.config.knownFctType[fctType][id.name]);
            dp.OID = oId;
            return dp;
        }
    };

    getAllKnownDps() {
        if(this.knownDPs)
            return this.knownDPs;
        else {
            return Object.entries(this.fct).reduce( ( dps, [fctId, fct] ) => {
                dps = Object.values(this.config.knownFctType[fct.fctType]).reduce( (dps, fDp) => {
                    const nDp = Object.assign({}, fDp );
                    nDp.OID = `/${this.subnet}/${fctId.replace(/-/, '/')}/${fDp.groupNr}/${fDp.memberNr}/0`;
                    dps[nDp.OID] = nDp;
                    return dps;
                }, dps );
                return dps;
            }, {})
        }
    };

    getDpInfo( dp ) {
        let oId;
        if(typeof dp === 'string') {
            oId = OId(dp);
            // ggf. cache
            dp = this.getKnownDp(dp);
        } else {
            oId = OId(dp.OID);
        }
        // is there any correction for this datapoint?
        const correct = this.config.correction[oId.fctType] ? this.config.correction[oId.fctType][oId.name] : undefined;

        const result = {
            indentText: (correct && correct.name[this.lang]) || this.getDpName(oId.groupNr, oId.memberNr)
        }

        if( dp ) {
            result.dataType = this.config.dataType[dp.typeId];
            if(!result.dataType) { throw new Error(`unknown typeId in datapoint ${oId.OID}`); }

            result.writeProt = (correct && correct.writeProt) || dp.writeProt;
// todo:    typeId 4 => Unit - date, time, range, ...
            const unit = (correct && correct.unit) || dp.unit;
            if(unit && unit !== '') result.unit = unit;

            const minValue = (correct && correct.minValue) || (dp.minValue ? Number(dp.minValue) : undefined);
            if( minValue && minValue !== '' ) result.minValue = minValue;
            const maxValue = (correct && correct.maxValue) || (dp.maxValue ? Number(dp.maxValue) : undefined);
            if( maxValue && maxValue !== '') result.maxValue = maxValue;

            let enums = (correct && correct.enums); // was corrected
            if(!enums && dp.enum) enums = dp.enum;
            if(enums) {
                if(typeof(enums) === 'string') {    // create enum object
                    const po = dp.enum.substring(1, dp.enum.length - 1).split(',').map(m => Number(m));
                    const en = this.getEnumNames( dp.groupNr, dp.memberNr, po );
                    if(en) result.enums = en;
                } else {
                    result.enums = enums;
                }
            }
        }
        return result;
    }

    getErrorText( code ) {
        return this._errorText[code];
    }

    async initStructureInfo() {
        if(!this._initStructureInfo) {
            this._dpNames       = await this.resRequest('VarIdentTexte', this.lang);
            this._levelNames    = await this.resRequest('EbenenTexte', this.lang);
            this._enumNames     = await this.resRequest('AufzaehlTexte', this.lang);
            this._initStructureInfo = true;
        }
    }
    /*
        async loadDatapointStructure() {
            const start = Date.now();

            this.log.debug('start reading datapoints from Windhager');
            const subnet    = (await this.lookup())[0];
            const nodes     = await this.lookup(`/${subnet}`);

            let cn = 1, cdp = 0;
            for(let n in nodes) {
                const node = nodes[n];
                this.log.debug(`... read node ${cn++} of ${nodes.length}`);
                for (let f in node.functions) {
                    const fct = node.functions[f];
                    let cl = 1;
                    if (!fct.lock && fct.fctType >= 0) {
                        this.log.debug(`... read function ${fct.name} - type: ${fct.fctType}`);
                        const levels = await this.lookup(`/${subnet}/${node.nodeId}/${fct.fctId}`);
                        for (let l in levels) {
                            const level = levels[l];
                            this.log.silly(`... level entry ${cl++} of ${levels.length}`);
                            const levelDps = await this.lookup(`/${subnet}/${node.nodeId}/${fct.fctId}/${level.id}`);
                            levelDps.forEach(dp => {
                                dp.levelId = level.id;
                                this.knownDPs[dp.OID] = dp;
                                cdp++
                            });
                        }
                    } else {
                        this.log.debug(`... skip function ${fct.name} - type: ${fct.fctType}`);
                    }
                }
            }
            this.log.debug(`${cdp} datapoints from Windhager readed in ${Date.now() - start} milliseconds`);
        }

        async readDeviceStruktur() {
            await this.initStructureInfo();

            const DPS       = [];

            const subnet    = (await this.lookup())[0];
            const nodes     = await this.lookup(`/${subnet}`);

            const rFcts     = {};
            const rNodes    = {};

            for(let n in nodes) {
                const node      = nodes[n];
                const rNode     = {
                    id:     node.nodeId,
                    name:   node.name,
                    fct:    {},
                    msg:    node.FE01msg
                };
                for(let f in node.functions) {
                    const fct   = node.functions[f];
                    const rFct  = {
                        id:     fct.fctId,
                        type:   fct.fctType,
                        name:   fct.name,
                        lock:   fct.lock
                    }
                    if(!fct.lock && fct.fctType >= 0) {
                        rFct.dp = {};
                        const levels = await this.lookup(`/${subnet}/${node.nodeId}/${fct.fctId}`);
                        for(let l in levels) {
                            const level     = levels[l];
                            const rLevel    = {
                                id:     level.id,
                                name:   this.getLevelName(fct.fctType, level.id),
                            };
                            const dps = await this.lookup(`/${subnet}/${node.nodeId}/${fct.fctId}/${level.id}`);
                            rLevel.dp = dps.reduce( (dps, dp) => {
                                const text = this.getDpName( dp.groupNr,dp.memberNr );
                                if(text) dp.text = text;
                                if(dp.enum) {
                                    const po = dp.enum.substring(1, dp.enum.length - 1).split(',').map(m => Number(m));
                                    const en = this.getEnumNames( dp.groupNr, dp.memberNr, po );
                                    if(en) dp.enumTest = en;
                                }
                                dps[dp.name] = dp;

                                DPS.push(dp.OID);

                                return dps;
                            }, {} );
                            rFct.dp[rLevel.id] = rLevel;
                        }
                    }
                    rNode.fct[rFct.id] = rFct;
                }
                rNodes[rNode.id] = rNode;
            }
            return { [subnet]: rNodes };
        }
    */
    /*
        datapointConfig(oId) {
            const fct = this.fct[oId.fctId];
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
    */
    async init( fullScan = false ) {
        if(!this._init) {
            const start = Date.now();

            if( fullScan ) {
                this.knownDPs = {};
                this.log.debug('First start - read the complete Windhager system - please wait, it needs some minutes');
            } else {
                this.log.debug('Initialize Windhager...');
            }

            const nodes = await this.lookup('/' + this.subnet);
            this.fct = {};

            let cNode = 1, cDatapoint = 0;
            for (let n in nodes) {
                const node = nodes[n];
                if(fullScan) this.log.debug(`... read node ${cNode++} of ${nodes.length}`);

                for (let f in node.functions) {
                    const fct = node.functions[f];
                    if (fct.fctType >= 0 && !fct.lock) {
                        const fctId = `${node.nodeId}-${fct.fctId}`;
                        this.fct[fctId] = {
                            fctType:    fct.fctType,
                            name:       fct.name
                        }
                        if (fct.fctType === 14) {
                            const modFct = await this.lookup(`/${this.subnet}/${node.nodeId}/${fct.fctId}/103`); // module functions
                            if (modFct && Array.isArray(modFct)) {
                                for (let dp in modFct) {
                                    if (modFct[dp].value != 0) {
                                        switch (modFct[dp].name) {
                                            case '05-076': // warm water
                                                this.fct[fctId].dhw = true;
                                                break;
                                            case '07-076':
                                                this.fct[fctId].heating = true;
                                                break;
                                        }
                                    }
                                }
                            }
                        }
                        if(fullScan) {
                            this.log.debug(`... read function ${fct.name} - type: ${fct.fctType}`);
                            const levels = await this.lookup(`/${this.subnet}/${node.nodeId}/${fct.fctId}`);
                            let cLevel = 1;
                            for (let l in levels) {
                                const level = levels[l];
                                this.log.silly(`... level entry ${cLevel++} of ${levels.length}`);
                                const levelDps = await this.lookup(`/${this.subnet}/${node.nodeId}/${fct.fctId}/${level.id}`);
                                levelDps.forEach(dp => {
                                    // clear not nessesary info
                                    delete dp.stepId;
                                    delete dp.subtypeId;
                                    delete dp.timestamp;
                                    delete dp.unitId;
                                    delete dp.value;
                                    // add level info for default structure
                                    dp.levelId = level.id;
                                    this.knownDPs[dp.OID] = dp;
                                    cDatapoint++
                                });
                            }
                        }
                    } else {
                        if(fullScan) this.log.debug(`... skip function ${fct.name} - type: ${fct.fctType}`);
                    }
                }
            }
            this._errorText = await this.resRequest('ErrorTexte', this.lang);
            if(fullScan)
                this.log.debug(`${cDatapoint} datapoints read from Windhager in ${Date.now() - start} milliseconds`);
            else
                this.log.debug(`Windhager initialized - ${Object.keys(this.fct).length} functions found`);
            this._init = true;
        }
    }
}

module.exports = {
    OId,
    WindhagerDevice
}