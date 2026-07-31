import {EventEmitter} from 'node:events';
export type Event={type:string;message:string;at:string;data?:Record<string,unknown>};
export class Events{private bus=new EventEmitter();on(listener:(event:Event)=>void){this.bus.on('event',listener);return()=>this.bus.off('event',listener);}emit(type:string,message:string,data?:Record<string,unknown>){const event={type,message,at:new Date().toISOString(),data};this.bus.emit('event',event);return event;}}
