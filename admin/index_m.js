//Windhager-Adapter - Copyright (c) by Martin Danne

const InitializeStructConfig = {
    cmd: 'none'
};

function load(settings, onChange) {
    if (!settings) return;
    $('.value').each(function () {
        var $key = $(this);
        var id = $key.attr('id');
        if ($key.attr('type') === 'checkbox') {
            // do not call onChange direct, because onChange could expect some arguments
            $key.prop('checked', settings[id])
                .on('change', () => onChange())
            ;
        } else {
            // do not call onChange direct, because onChange could expect some arguments
            $key.val(settings[id])
                .on('change', () => onChange())
                .on('keyup', () => onChange())
            ;
        }
    });

    function setFileInfo ( file ) {
        $('#fileInfo').html(`File type: ${file.type}   ${file.type === 'flat' ?
                `${Object.keys(file.states).length} states` : `${Object.keys(file.fct).length} functions` }`);
    }

    socket.emit('getState', `${adapter}.${instance}._initializeStructure`, function (err, res) {
        if(!err, res) {
            const val = JSON.parse(res.val);
            InitializeStructConfig.cmd              = val.cmd;
            $(`input:radio[value=${val.cmd}]`).prop('checked', true);
            InitializeStructConfig.file             = val.file;
            $('#fileImport').attr('disabled', !val.file ? 'disabled' : null);
            setFileInfo(val.file);
            //            $('#fileInfo').html(`File type: ${val.file.type}   ${val.file.type === 'flat' ?
//                  `${Object.keys(val.file.states).length} states` : `${Object.keys(val.file.fct).length} functions` }`);
            InitializeStructConfig.deleteBefore = val.deleteBefore;
            $('#deleteStruct').prop('checked', val.deleteBefore);
        }
    });

    //import and export state model
    $('#btnExport').on('click', function() {
        const generic = ( $('input[name=exportStruct]:checked').val() === 'struct' );
        exportDeviceStructure( generic, (err, res) => {
            if(!err && res) {
                generateFile('windhager-structure.json', res);
            }
        });
    });
    $('input[name=importStruct]').on('change', function () {
        InitializeStructConfig.cmd = $('input[name=importStruct]:checked').val();
        onChange();
    });
    $('#deleteStruct').on('change', function () {
        InitializeStructConfig.deleteBefore = $('#deleteStruct').prop('checked');
        onChange();
    });
    $('#btnImport').on('click', function() {
        var input = document.createElement('input');
        input.setAttribute('type', 'file');
        input.setAttribute('id', 'files');
        input.setAttribute('opacity', 0);
        input.addEventListener('change', function (e) {
            handleSelectImport(e, function (obj) {
                if(obj.model && obj.model === 'windhager.adapter.export') {
                    InitializeStructConfig.cmd = 'file';
                    InitializeStructConfig.file = obj;
                    $('#fileImport').attr('disabled', null);
                    $('#fileImport').prop('checked', true);
                    setFileInfo(obj);
//                    $('#fileInfo').html(`File type: ${obj.type}   ${obj.type === 'flat' ?
//                            `${Object.keys(obj.states).length} states` : `${Object.keys(obj.fct).length} functions` }`);
                    onChange();
                } else {
                    $('#fileInfo').html('unknown File format');
                }
            });
        }, false);
        (input.click)();
    });

    onChange(false);
    // reinitialize all the Materialize labels on the page if you are dynamically adding inputs:
    if (M) M.updateTextFields();
}

// This will be called by the admin adapter when the user presses the save button
function save(callback) {
    // example: select elements with class=value and build settings object
    var obj = {};
    $('.value').each(function () {
        var $this = $(this);
        if ($this.attr('type') === 'checkbox') {
            obj[$this.attr('id')] = $this.prop('checked');
        } else {
            obj[$this.attr('id')] = $this.val();
        }
    });

    socket.emit('setState', `${adapter}.${instance}._initializeStructure`, {val: JSON.stringify(InitializeStructConfig), ack: false});
    callback(obj);
}

// Generator Export
function exportDeviceStructure( generic, callback ) {
    try {
        socket.emit('getObjectView', adapter, 'subnetObjects', { startkey: '', endkey: '\u9999' }, function (err, res) {
            let objs;
            // generate export
            if ( generic ) {
                const firstFct = {};
                objs = res.rows.reduce((result, {id, value}) => {
                    try {
                        const [match, subnet, fct, sId] = id.match(new RegExp(`^${adapter}\\.${instance}\\.(\\d+)\\.?(\\d\\d-\\d)?\\.?(.+)?`, ''));
                        if (match) {
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
//                            showMessage(e.message, _('Error'), 'alert');
                    }
                    return result;
                }, {model: "windhager.adapter.export", type: "struct", subnet: null, fct: {}, fctType: {}});
            } else {
                objs = {
                    model: "windhager.adapter.export",
                    type: "flat",
                    states: res.rows.reduce((result, {id, value}) => {
                        try {
                            const [match, sId] = id.match(new RegExp(`^${adapter}\\.${instance}\\.(.+)`, '')); // `^windhager\.\d+\.((\d+)\.(\d+-\d+)\..+)`
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
//                                showMessage(e.message, _('Error'), 'alert');
                        }
                        return result;
                    }, {})
                };
            }
            callback( undefined, objs );
        });
    } catch (e) {
        callback( e );
    }
}

function handleSelectImport(evt, callback) {
    const f = evt.target.files[0];
    if (f) {
        const r = new FileReader();
        r.onload = function(e) {
            let contents = e.target.result;
            try {
                const obj = JSON.parse(contents);
                callback(obj);
            } catch (e) {
//                showError(e.toString());
            }
        };
        r.readAsText(f);
    } else {
        alert('Failed to open JSON File');
    }
}
