{
	"patcher": {
		"fileversion": 1,
		"appversion": {
			"major": 9,
			"minor": 0,
			"revision": 10,
			"architecture": "x64",
			"modernui": 1
		},
		"classnamespace": "box",
		"rect": [80.0, 80.0, 700.0, 460.0],
		"openrect": [0.0, 0.0, 420.0, 169.0],
		"default_fontsize": 10.0,
		"default_fontname": "Ableton Sans Medium",
		"gridsize": [8.0, 8.0],
		"openinpresentation": 1,
		"autosave": 0,
		"devicewidth": 420.0,
		"description": "Builds and rerolls a 16-pad Drum Rack from your own categorized sample packs. Drop it on a MIDI track.",
		"digest": "Categorizes sample packs by filename and generates Drum Rack kits.",
		"tags": "drum rack, sample pack, generator, max for live",
		"style": "",
		"boxes": [
			{
				"box": {
					"id": "c-title",
					"maxclass": "comment",
					"patching_rect": [8.0, 400.0, 220.0, 18.0],
					"numinlets": 1,
					"numoutlets": 0,
					"outlettype": [],
					"parameter_enable": 0,
					"text": "DDW Drum Rack Generator",
					"fontsize": 12.0,
					"fontname": "Ableton Sans Medium",
					"textcolor": [0.82, 0.82, 0.82, 1.0]
				}
			},
			{
				"box": {
					"id": "c-help",
					"maxclass": "comment",
					"text": "Clean-room rebuild, own implementation. Keep drg-*.js next to this device. live.thisdevice bangs init -- do not call LiveAPI from loadbang. MIDI passes through to the Drum Rack below.",
					"patching_rect": [20.0, 20.0, 560.0, 32.0],
					"fontsize": 11.0,
					"numinlets": 1,
					"numoutlets": 0,
					"outlettype": [],
					"presentation": 0
				}
			},
			{
				"box": {
					"id": "obj-this",
					"maxclass": "newobj",
					"text": "live.thisdevice",
					"patching_rect": [20.0, 70.0, 110.0, 22.0],
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", ""],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "obj-dropfile",
					"maxclass": "dropfile",
					"patching_rect": [20.0, 110.0, 150.0, 60.0],
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", ""],
					"types": []
				}
			},
			{
				"box": {
					"id": "obj-opendialog",
					"maxclass": "newobj",
					"text": "opendialog folder",
					"patching_rect": [200.0, 110.0, 120.0, 22.0],
					"numinlets": 1,
					"numoutlets": 2,
					"outlettype": ["", "bang"],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "obj-prepend-folder",
					"maxclass": "newobj",
					"text": "prepend folderdrop",
					"patching_rect": [20.0, 180.0, 140.0, 22.0],
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [""],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "obj-textedit",
					"maxclass": "textedit",
					"patching_rect": [360.0, 110.0, 220.0, 60.0],
					"numinlets": 1,
					"numoutlets": 4,
					"outlettype": ["", "int", "", ""],
					"fontsize": 10.0,
					"border": 1,
					"keymode": 1,
					"outputmode": 1,
					"readonly": 0,
					"varname": "aliasedit"
				}
			},
			{
				"box": {
					"id": "obj-prepend-alias",
					"maxclass": "newobj",
					"text": "prepend aliastext",
					"patching_rect": [360.0, 190.0, 140.0, 22.0],
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [""],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "obj-jsui",
					"maxclass": "jsui",
					"text": "jsui @filename drg-ui.js",
					"patching_rect": [20.0, 260.0, 420.0, 169.0],
					"presentation": 1,
					"presentation_rect": [0.0, 0.0, 420.0, 169.0],
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [""],
					"border": 0,
					"parameter_enable": 0,
					"varname": "drgui",
					"filename": "drg-ui.js",
					"saved_object_attributes": {
						"filename": "drg-ui.js",
						"parameter_enable": 0,
						"autowatch": 1
					}
				}
			},
			{
				"box": {
					"id": "obj-route-jsui-out",
					"maxclass": "newobj",
					"text": "route openfolder note",
					"patching_rect": [200.0, 220.0, 160.0, 22.0],
					"numinlets": 1,
					"numoutlets": 3,
					"outlettype": ["", "", ""],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "obj-midiin",
					"maxclass": "newobj",
					"text": "midiin",
					"patching_rect": [500.0, 260.0, 60.0, 22.0],
					"numinlets": 1,
					"numoutlets": 1,
					"outlettype": [""],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "obj-midiout",
					"maxclass": "newobj",
					"text": "midiout",
					"patching_rect": [500.0, 300.0, 60.0, 22.0],
					"numinlets": 1,
					"numoutlets": 0,
					"outlettype": [],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "obj-noteout",
					"maxclass": "newobj",
					"text": "noteout",
					"patching_rect": [20.0, 340.0, 60.0, 22.0],
					"numinlets": 3,
					"numoutlets": 0,
					"outlettype": [],
					"fontsize": 10.0,
					"fontname": "Ableton Sans Medium"
				}
			},
			{
				"box": {
					"id": "c-midi",
					"maxclass": "comment",
					"patching_rect": [500.0, 340.0, 200.0, 18.0],
					"numinlets": 1,
					"numoutlets": 0,
					"outlettype": [],
					"parameter_enable": 0,
					"text": "raw MIDI passthrough to the Drum Rack",
					"fontsize": 10.0,
					"textcolor": [0.55, 0.55, 0.55, 1.0]
				}
			}
		],
		"lines": [
			{
				"patchline": {
					"source": ["obj-this", 0],
					"destination": ["obj-jsui", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-dropfile", 0],
					"destination": ["obj-prepend-folder", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-opendialog", 0],
					"destination": ["obj-prepend-folder", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-prepend-folder", 0],
					"destination": ["obj-jsui", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-jsui", 0],
					"destination": ["obj-route-jsui-out", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-route-jsui-out", 0],
					"destination": ["obj-opendialog", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-textedit", 0],
					"destination": ["obj-prepend-alias", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-prepend-alias", 0],
					"destination": ["obj-jsui", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-route-jsui-out", 1],
					"destination": ["obj-noteout", 0]
				}
			},
			{
				"patchline": {
					"source": ["obj-midiin", 0],
					"destination": ["obj-midiout", 0]
				}
			}
		],
		"dependency_cache": [
			{ "name": "drg-ui.js", "bootpath": ".", "type": "TEXT", "implicit": 1 },
			{ "name": "drg-classify.js", "bootpath": ".", "type": "TEXT", "implicit": 1 },
			{ "name": "drg-duration.js", "bootpath": ".", "type": "TEXT", "implicit": 1 },
			{ "name": "drg-scan.js", "bootpath": ".", "type": "TEXT", "implicit": 1 }
		],
		"project": {
			"version": 1,
			"creationdate": 3781198800,
			"modificationdate": 3781198800,
			"viewrect": [25.0, 124.0, 300.0, 500.0],
			"autoorganize": 1,
			"hideprojectwindow": 1,
			"showdependencies": 1,
			"autolocalize": 0,
			"contents": { "patchers": {} },
			"layout": {},
			"searchpath": {},
			"detailsvisible": 0,
			"amxdtype": 1835887981,
			"readonly": 0,
			"devpathtype": 0,
			"devpath": ".",
			"sortmode": 0,
			"viewmode": 0,
			"includepackages": 0
		}
	}
}
