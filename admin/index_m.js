//Windhager-Adapter - Copyright (c) by Martin Danne

var reInit = {
    cmd:    'none',
    file:   null
}

function load(settings, onChange) {
    if (!settings) return;
    $('.config').each(function () {
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
        if(file)
            $('#fileInfo').html(`File type: ${file.type}   ${file.type === 'flat' ?
                   `${Object.keys(file.states).length} states` : `${Object.keys(file.fct).length} functions` }`);
        else
            $('#fileInfo').html('');
    }

    socket.emit('getObject', `${adapter}.${instance}`, function (err, res) {
        if(res && res.native && res.native.reInit) reInit = res.native.reInit;

        $(`input:radio[value=${reInit.cmd}]`).prop('checked', true);
        if(reInit.file) {
            $('#fileImport').attr('disabled', null);
        }
        setFileInfo(reInit.file);

        $('input[name=importStruct]').on('change', function () {
            reInit.cmd = $('input[name=importStruct]:checked').val();
            onChange();
        });

        $('#fullScan').prop('checked', reInit.fullScan);
        $('#fullScan').on('change', function () {
            reInit.fullScan = $('#fullScan').prop('checked');
            onChange();
        });
        $('#deleteStruct').prop('checked', reInit.deleteStruct);
        $('#deleteStruct').on('change', function () {
            reInit.deleteStruct = $('#deleteStruct').prop('checked');
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
                        reInit.cmd  = 'import';
                        reInit.file = obj;
                        $('#fileImport').attr('disabled', null)
                                        .prop('checked', true);
                        setFileInfo(obj);
                        onChange();
                    } else {
                        $('#fileInfo').html('unknown File format');
                    }
                });
            }, false);
            (input.click)();
        });
    } );

    //import and export state model
    $('#btnExport').on('click', function() {
        exportDeviceStructure( true, (err, res) => {
            if(!err && res) {
                generateFile('windhager-structure.json', res);
            }
        });
    });
    $('#btnBackup').on('click', function() {
        exportDeviceStructure( false, (err, res) => {
            if(!err && res) {
                generateFile('windhager-state-backup.json', res);
            }
        });
    });

    onChange(false);
    // reinitialize all the Materialize labels on the page if you are dynamically adding inputs:
    if (M) M.updateTextFields();
}

// This will be called by the admin adapter when the user presses the save button
function save(callback) {
    // example: select elements with class=value and build settings object
    var obj = {};
    $('.config').each(function () {
        var $this = $(this);
        if ($this.attr('type') === 'checkbox') {
            obj[$this.attr('id')] = $this.prop('checked');
        } else {
            obj[$this.attr('id')] = $this.val();
        }
    });

    if( reInit.cmd !== 'import') reInit.file = null;
    socket.emit('extendObject', `${adapter}.${instance}`, { native: { reInit : reInit } });

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
