//
// nsbca.js
//--------------------
// Reads NSBCA files (bone animations) for use in combination with an NSBMD (model) file
// by RHY3756547
//
// includes: gl-matrix.js (glMatrix 2.0)
// /formats/nitro.js
//

// most investigation done by florian for the mkds course modifier.
// I've tried to keep things much simpler than they were in his code.

import { nitro, nitro_nitroInfos } from "./nitro";
import { MKSUtils } from "./utils";

export type nsbca_rot = {
	pivot: true;
	param: number;
	a: number;
	b: number;
} | {
	pivot: false;
	mat: mat3;
}

type nsbca_scale = {
	s1: number;
	s2: number;
}[]

type nsbca_obj_trans_inf = {
	startFrame: number,
	endFrame: number,
	halfSize: number,
	speed: number,
	off: number,
}

type nsbca_obj_trans = {
	flag: number,
	translate: number[][],
	tlExtra: nsbca_obj_trans_inf[],

	rotate: nsbca_rot[],
	rotExtra: nsbca_obj_trans_inf,

	scale: [nsbca_scale, nsbca_scale, nsbca_scale],
	scExtra: nsbca_obj_trans_inf[],
}

type nsbca_obj = {
	baseOff: number;
	off1: number;
	off2: number;
	unknown: number;
	frames: number;
	nextoff: number;
	stamp: string;
	numObj: number;
	trans: nsbca_obj_trans[];
}

export class nsbca implements MKJSDataFormator {
	input: MKJSDataInput;
	mainOff: number;
	animData: nitro_nitroInfos<nsbca_obj>;
	speeds: number[];

	constructor(input: MKJSDataInput) {
		this.input = input;

		this.mainOff = undefined;
		this.animData = undefined;
		this.speeds = [1.0, 0.5, 1 / 4];

		if (this.input != null) {
			this.load(this.input);
		}
	}

	load(input: MKJSDataInput) {
		var view = new DataView(input);
		var header = null;
		var offset = 0;
		var tex;

		//nitro 3d header
		header = nitro.readHeader(view);
		if (header.stamp != "BCA0") throw "NSBCA invalid. Expected BCA0, found " + header.stamp;
		if (header.numSections > 1) throw "NSBCA invalid. Too many sections - should have 1 maximum.";
		offset = header.sectionOffsets[0];
		//end nitro

		this.mainOff = offset;

		var stamp = MKSUtils.asciireadChar(view, offset + 0x0) + MKSUtils.asciireadChar(view, offset + 0x1) + MKSUtils.asciireadChar(view, offset + 0x2) + MKSUtils.asciireadChar(view, offset + 0x3);
		if (stamp != "JNT0") throw "NSBCA invalid. Expected JNT0, found " + stamp;

		this.animData = nitro.read3dInfo(view, this.mainOff + 8, (...args) => this._animInfoHandler(args[0], args[1])) 
	}

	_animInfoHandler(view: DataView, off: number): nsbca_obj {
		var offset = this.mainOff + view.getUint32(off, true);
		const obj: nsbca_obj = {
			baseOff: offset,
			stamp: MKSUtils.asciireadChar(view, offset + 0x0) + MKSUtils.asciireadChar(view, offset + 0x2) + MKSUtils.asciireadChar(view, offset + 0x3),
			frames: view.getUint16(offset + 0x4, true),
			numObj: view.getUint16(offset + 0x6, true),
			unknown: view.getUint32(offset + 0x8, true), //NOTE: this may be a flag. used later to specify extra frames if not = 3 
			off1: view.getUint32(offset + 0xC, true),
			off2: view.getUint32(offset + 0x10, true), //offset to rotation data
			nextoff: off + 4,
			trans: undefined
		};		
		
		offset += 0x14;
		var transforms = [];
		for (var i = 0; i < obj.numObj; i++) {
			var off2 = view.getUint16(offset, true) + obj.baseOff;
			transforms.push(this._readTrans(view, off2, obj));
			offset += 2;
		}
		obj.trans = transforms;

		return obj;
	}

	_readTrans(view: DataView, off: number, obj: nsbca_obj) {
		var flag = view.getUint16(off, true); //--zyx-Sr-RZYX-T-
		off += 4;

		var transform: nsbca_obj_trans = {
			flag: undefined,
			translate: undefined,
			tlExtra: undefined,
			rotate: undefined,
			rotExtra: undefined,
			scale: undefined,
			scExtra: undefined
		};
		transform.flag = flag;

		if (!((flag >> 1) & 1)) { //T: translation
			var translate: number[][] = [[], [], []]; //store translations in x,y,z arrays
			var tlExtra = [];

			for (var i = 0; i < 3; i++) { //iterate over x y z (for translation)
				var f = (flag >> (3 + i)) & 1;
				if (f) { //one value
					translate[i].push(view.getInt32(off, true) / 4096);
					off += 4;
				} else { //credit to florian for cracking this.
					var inf: nsbca_obj_trans_inf = {
						startFrame: undefined,
						endFrame: undefined,
						halfSize: undefined,
						speed: undefined,
						off: undefined
					};
					inf.startFrame = view.getUint16(off, true)
					var dat = view.getUint16(off + 2, true)
					inf.endFrame = dat & 0x0FFF;
					inf.halfSize = ((dat >> 12) & 3);
					inf.speed = this.speeds[((dat >> 14) & 3)];
					inf.off = view.getUint32(off + 4, true);

					var extra = (obj.unknown != 3) ? 0 : (obj.frames - inf.endFrame);
					var length = Math.ceil((inf.endFrame - inf.startFrame) * inf.speed);
					var w = (inf.halfSize) ? 2 : 4;

					var off2 = obj.baseOff + inf.off;
					for (var j = 0; j < length; j++) {
						translate[i].push(((inf.halfSize) ? view.getInt16(off2, true) : view.getInt32(off2, true)) / 4096);
						off2 += w;
					}


					tlExtra[i] = inf;
					off += 8;
				}
			}

			transform.translate = translate;
			transform.tlExtra = tlExtra;
		}

		if (!((flag >> 6) & 1)) { //R: rotation, which is both fun and exciting.

			var rotate = [];
			var rotExtra;

			var f = (flag >> 8) & 1;
			if (f) { //one value
				rotate.push(this._readRotation(view, off, obj));
				off += 4;
			} else { //credit to florian for cracking this.
				var inf: nsbca_obj_trans_inf = {
					startFrame: undefined,
					endFrame: undefined,
					halfSize: undefined,
					speed: undefined,
					off: undefined
				};
				inf.startFrame = view.getUint16(off, true)
				var dat = view.getUint16(off + 2, true) //low 12 bits are end frame, high 4 are size flag and speed
				inf.endFrame = dat & 0x0FFF;
				inf.halfSize = ((dat >> 12) & 3); //not used by rotation?
				inf.speed = this.speeds[((dat >> 14) & 3)];
				inf.off = view.getUint32(off + 4, true);
				var extra = (obj.unknown != 3) ? 0 : (obj.frames - inf.endFrame);
				//florian's rotate code seems to ignore this extra value. I'll need more examples of nsbca to test this more thoroughly.
				var length = Math.ceil((inf.endFrame - inf.startFrame) * inf.speed);

				var off2 = obj.baseOff + inf.off;
				try {
					for (var j = 0; j < length; j++) {
						rotate.push(this._readRotation(view, off2, obj));
						off2 += 2;
					}
				} catch (e) {

				}
				rotExtra = inf;
				off += 8;
			}

			transform.rotate = rotate;
			transform.rotExtra = rotExtra;
		}

		if (!((flag >> 9) & 1)) { //S: scale
			var scales: [nsbca_scale, nsbca_scale, nsbca_scale] = [
				[],
				[],
				[]
			]; //store scales in x,y,z arrays
			var scExtra = [];

			for (var i = 0; i < 3; i++) { //iterate over x y z (for scale)
				var f = (flag >> (11 + i)) & 1;
				if (f) { //one value
					scales[i].push({
						s1: view.getInt32(off, true) / 4096,
						s2: view.getInt32(off, true) / 4096
					});
					off += 8;
				} else { //credit to florian for cracking this.

					var inf: nsbca_obj_trans_inf = {
						startFrame: undefined,
						endFrame: undefined,
						halfSize: undefined,
						speed: undefined,
						off: undefined
					};

					inf.startFrame = view.getUint16(off, true)
					var dat = view.getUint16(off + 2, true)
					inf.endFrame = dat & 0x0FFF;
					inf.halfSize = ((dat >> 12) & 3);
					inf.speed = this.speeds[((dat >> 14) & 3)];
					inf.off = view.getUint32(off + 4, true);

					var extra = (obj.unknown != 3) ? 0 : (obj.frames - inf.endFrame);
					var length = Math.ceil((inf.endFrame - inf.startFrame) * inf.speed);
					var w = ((inf.halfSize) ? 2 : 4);

					var off2 = obj.baseOff + inf.off;
					for (var j = 0; j < length; j++) {
						scales[i].push({
							s1: ((inf.halfSize) ? view.getInt16(off2, true) : view.getInt32(off2, true)) / 4096,
							s2: ((inf.halfSize) ? view.getInt16(off2 + w, true) : view.getInt32(off2 + w, true)) / 4096
						});
						off2 += w * 2;
					}
					scExtra[i] = inf;
					off += 8;
				}
			}

			transform.scale = scales;
			transform.scExtra = scExtra;
		}

		return transform;
	}

	_readRotation(view: DataView, off: number, obj: nsbca_obj): nsbca_rot {
		var dat = view.getInt16(off, true);
		var ind = (dat & 0x7FFF);
		var mode = (dat >> 15);

		if (mode) { //rotation is pivot
			var off2 = obj.baseOff + obj.off1 + ind * 6; //jump to rotation data
			return {
				pivot: true,
				param: view.getUint16(off2, true),
				a: view.getInt16(off2 + 2, true) / 4096,
				b: view.getInt16(off2 + 4, true) / 4096
			};
		} else {
			var off2 = obj.baseOff + obj.off2 + ind * 10; //jump to rotation data
			var d1 = view.getUint16(off2, true);
			var d2 = view.getUint16(off2 + 2, true);
			var d3 = view.getUint16(off2 + 4, true);
			var d4 = view.getUint16(off2 + 6, true);
			var d5 = view.getUint16(off2 + 8, true);

			var i6 = ((d5 & 7) << 12) | ((d1 & 7) << 9) | ((d2 & 7) << 6) | ((d3 & 7) << 3) | ((d4 & 7));
			//if (i6&4096) i6 = (-8192)+i6;

			var v1: vec3 = [d1 >> 3, d2 >> 3, d3 >> 3];
			var v2: vec3 = [d4 >> 3, d5 >> 3, i6];

			for (var i = 0; i < 3; i++) {
				if (v1[i] & 4096) v1[i] -= 8192;
				if (v2[i] & 4096) v2[i] -= 8192;
			}

			vec3.scale(v1, v1, 1 / 4096);
			vec3.scale(v2, v2, 1 / 4096);
			var v3 = vec3.cross([0, 0, 0], v1, v2);

			var mat = mat3.clone([
				v1[0], v1[1], v1[2],
				v2[0], v2[1], v2[2],
				v3[0], v3[1], v3[2]
			]);

			return {
				pivot: false,
				mat: mat
			};
		}
	}
}