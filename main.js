/*jslint browser: true*/
/*global Tangram, gui */

map = (function () {
    'use strict';

    var map_start_location = [0, 0, 2];
    var global_min = 0;
    var global_max = 8848;
    var uminValue, umaxValue; // storage
    var scene_loaded = false;
    var moving = false;
    var analysing = false;

    /*** URL parsing ***/

    // leaflet-style URL hash pattern:
    // #[zoom],[lat],[lng]
    var url_hash = window.location.hash.slice(1, window.location.hash.length).split('/');

    if (url_hash.length == 3) {
        map_start_location = [url_hash[1],url_hash[2], url_hash[0]];
        // convert from strings
        map_start_location = map_start_location.map(Number);
    }

    /*** Map ***/

    var map = L.map('map',
        {"keyboardZoomOffset" : .05,
        "inertiaDeceleration" : 10000,
        "zoomSnap" : .001}
    );
    var ready = false;
var do_analyse = false;
var lastmax, lastmin;
var secondtime = false;
var spread = 1;
var lastumax = null;
var diff = null;
    var layer = Tangram.leafletLayer({
        scene: 'scene.yaml',
        attribution: 'Map by <a href="https://mapzen.com/tangram" target="_blank">Tangram</a> | <a href="https://github.com/tangram/heightmapper" target="_blank">Fork This</a>',
        postUpdate: function() {
            if (gui.autoexpose) {
                // three stages:
                // 1) start analysis
                if (!analysing && !done) { 
                    expose();
                }
                // 2) continue analysis
                else if (analysing && !done) {
                    start_analysis();
                }
                // 3) stop analysis and reset
                else if (done) {
                    lastmax = 0;
                    lastmin = 255;
                    done = false;
                }
            }
        }
    });
    
    // from https://davidwalsh.name/javascript-debounce-function
    function debounce(func, wait, immediate) {
        var timeout;
        return function() {
            var context = this, args = arguments;
            var later = function() {
                timeout = null;
                if (!immediate) func.apply(context, args);
            };
            var callNow = immediate && !timeout;
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
            if (callNow) func.apply(context, args);
        };
    };

    function linkFromBlob(blob) {
        var urlCreator = window.URL || window.webkitURL;
        return urlCreator.createObjectURL( blob );
    }

    function expose() {
        analysing = true;
        if (typeof gui != 'undefined' && gui.autoexpose == false) return false;
        if (scene_loaded) {
            start_analysis();
        } else {
            // wait for scene to initialize first
            scene.initializing.then(function() {
                start_analysis();
            });
        }
    }

    function updateGUI() {
        // update dat.gui controllers
        for (var i in gui.__controllers) {
            gui.__controllers[i].updateDisplay();
        }
    }

    function start_analysis() {
        // set levels
        var levels = analyse();
        diff = levels.max - lastumax;
        if (typeof levels.max !== 'undefined') lastumax = levels.max;
        else diff = 1;
        scene.styles.hillshade.shaders.uniforms.u_min = levels.min;
        scene.styles.hillshade.shaders.uniforms.u_max = levels.max;
        scene.requestRedraw();
    }

    function analyse() {
        var ctx = tempCanvas.getContext("2d"); // Get canvas 2d context
        ctx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
        // redraw canvas smaller in testing canvas, for speed
        ctx.drawImage(scene.canvas,0,0,scene.canvas.width/4,scene.canvas.height/4);
        // get all the pixels
        var pixels = ctx.getImageData(0,0, tempCanvas.width, tempCanvas.height);

        var val;
        var counts = {};
        var empty = true;
        var max = 0, min = 255;
        // only check every nth pixel (vary with browser size)
        // var stride = Math.round(img.height * img.width / 1000000);
        // 4 = only sample the red value in [R, G, B, A]
        for (var i = 0; i < tempCanvas.height * tempCanvas.width * 4; i += 4) {
            val = pixels.data[i];
            var alpha = pixels.data[i+3];
            if (alpha === 0) { // empty pixel, skip to the next one
                // console.log('empty')
                continue;
            }
            // if we got this far, we found at least one non-empty pixel!
            empty = false;
            // update counts, to get a histogram
            counts[val] = counts[val] ? counts[val]+1 : 1;

            // update min and max so far
            min = Math.min(min, val);
            max = Math.max(max, val);
        }

        if (empty) {
            // no pixels found, skip the analysis
            return false;
        }
        if (max == 255 && min == 0 && diff < 0 ) {
            console.log('max, min:', max, min, '  diff:', diff)
            // looks good, done
            console.log("DONE")
            analysing = false;
            done = true;
            spread = 2;
            return false;
        }
        if (max == 255 && min == 0) {
            // over-exposed, widen the range
            spread *= 2;
            console.log("WIDEN >", spread)
            max += spread;
            min -= spread;
        }
        lastmax = max;
        lastmin = min;

        // calculate adjusted elevation settings based on current pixel
        // values and elevation settings
        var range = (gui.u_max - gui.u_min);
        var minadj = (min / 255) * range + gui.u_min;
        var maxadj = (max / 255) * range + gui.u_min;

        // keep levels in range
        minadj = Math.max(minadj, -11000);
        maxadj = Math.min(maxadj, 8900);
        // only let the minimum value go below 0 if ocean data is included
        minadj = gui.include_oceans ? minadj : Math.max(minadj, 0);

        // keep min and max separated
        if (minadj === maxadj) maxadj += 10;

        // get the width of the current view in meters
        // compare to the current elevation range in meters
        // the ratio is the "height" of the current scene compared to its width –
        // multiply it by the width of your 3D mesh to get the height
        var zrange = (gui.u_max - gui.u_min);
        var xscale = zrange / scene.view.size.meters.x;
        gui.scaleFactor = xscale +''; // convert to string to make the display read-only

        scene.styles.hillshade.shaders.uniforms.u_min = minadj;
        scene.styles.hillshade.shaders.uniforms.u_max = maxadj;

        // update dat.gui controllers
        gui.u_min = minadj;
        gui.u_max = maxadj;
        updateGUI();

        return {max: maxadj, min: minadj}
    }

    window.layer = layer;
    var scene = layer.scene;
    window.scene = scene;

    // setView expects format ([lat, long], zoom)
    map.setView(map_start_location.slice(0, 3), map_start_location[2]);

    var hash = new L.Hash(map);

    // Create dat GUI
    var gui;
    function addGUI () {
        gui.domElement.parentNode.style.zIndex = 5; // make sure GUI is on top of map
        window.gui = gui;
        gui.u_max = 8848.;
        gui.add(gui, 'u_max', -10916., 8848).name("max elevation").onChange(function(value) {
            scene.styles.hillshade.shaders.uniforms.u_max = value;
            scene.requestRedraw();
        });
        // gui.u_min = -10916.;
        gui.u_min = 0.;
        gui.add(gui, 'u_min', -10916., 8848).name("min elevation").onChange(function(value) {
            scene.styles.hillshade.shaders.uniforms.u_min = value;
            scene.requestRedraw();
        });
        gui.scaleFactor = 1 +'';
        gui.add(gui, 'scaleFactor').name("z:x scale factor");
        gui.autoexpose = true;
        gui.add(gui, 'autoexpose').name("auto-exposure").onChange(function(value) {
            sliderState(!value);
            if (value) {
                // store slider values
                uminValue = gui.u_min;
                umaxValue = gui.u_max;
                expose();
            } else if (typeof uminValue != 'undefined') {
                // retrieve slider values
                scene.styles.hillshade.shaders.uniforms.u_min = uminValue;
                scene.styles.hillshade.shaders.uniforms.u_max = umaxValue;
                scene.requestRedraw();
                gui.u_min = uminValue;
                gui.u_max = umaxValue;
                updateGUI();
            }
        });
        gui.include_oceans = false;
        gui.add(gui, 'include_oceans').name("include ocean data").onChange(function(value) {
            if (value) global_min = -10916;
            else global_min = 0;
            scene.styles.hillshade.shaders.uniforms.u_min = uminValue;
            expose();
        });
        gui.export = function () {
            // button to open screenshot in a new tab – 'save as' to save to disk
            scene.screenshot().then(function(screenshot) { window.open(screenshot.url); });
        }
        gui.add(gui, 'export');
        gui.help = function () {
            // show help screen and input blocker
            toggleHelp(true);
        }
        gui.add(gui, 'help');
        // set scale factor text field to be uneditable but still selectable (for copying)
        gui.__controllers[2].domElement.firstChild.setAttribute("readonly", true);

    }

    // disable sliders when autoexpose is on
    function sliderState(active) {
        var pointerEvents = active ? "auto" : "none";
        var opacity = active ? 1. : .5;
        gui.__controllers[0].domElement.parentElement.style.pointerEvents = pointerEvents;
        gui.__controllers[0].domElement.parentElement.style.opacity = opacity;
        gui.__controllers[1].domElement.parentElement.style.pointerEvents = pointerEvents;
        gui.__controllers[1].domElement.parentElement.style.opacity = opacity;
    }

    // show and hide help screen
    function toggleHelp(active) {
        var visibility = active ? "visible" : "hidden";
        document.getElementById('help').style.visibility = visibility;
        document.getElementById('help-blocker').style.visibility = visibility;
    }


    document.onkeypress = function (e) {
        e = e || window.event;
        // listen for "h"
        if (e.which == 104 && document.activeElement != document.getElementsByClassName('leaflet-pelias-input')[0]) {
            // toggle UI
            var display = map._controlContainer.style.display;
            map._controlContainer.style.display = (display === "none") ? "block" : "none";
            document.getElementsByClassName('dg')[0].style.display = (display === "none") ? "block" : "none";
        }
    };

    /***** Render loop *****/
var done = false;
var tempCanvas;
    window.addEventListener('load', function () {
        // Scene initialized
        layer.on('init', function() {
            gui = new dat.GUI({ autoPlace: true, hideable: true, width: 300 });
            addGUI();
            // resetViewComplete();
            scene.subscribe({
                // will be triggered when tiles are finished loading
                // and also manually by the moveend event
                view_complete: function() {
                }
            });
            scene_loaded = true;

            sliderState(false);

            tempCanvas = document.createElement("canvas");
            tempCanvas.width = scene.canvas.width/4; 
            tempCanvas.height = scene.canvas.height/4;
    
        });
        layer.addTo(map);

        // bind help div onclicks
        document.getElementById('help').onclick = function(){toggleHelp(false)};
        document.getElementById('help-blocker').onclick = function(){toggleHelp(false)};

        // debounce moveend event
        var moveend = debounce(function(e) {
            moving = false;
            // manually reset view_complete
            scene.resetViewComplete();
            scene.requestRedraw();
        }, 250);

        map.on("movestart", function (e) { moving = true; });
        map.on("moveend", function (e) { moveend(e) });

    });

    return map;

}());
