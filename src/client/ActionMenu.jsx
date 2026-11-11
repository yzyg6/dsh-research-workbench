import React from 'react';
import {Icon} from './icons.jsx';

/** Native details keyboard behavior; low-frequency actions take no permanent rows. */
export function ActionMenu({label,children,icon='more'}){
  const ref=React.useRef(null);
  const [open,setOpen]=React.useState(false);
  React.useEffect(()=>{
    if(!open)return;
    const close=()=>{if(ref.current)ref.current.open=false};
    const outside=event=>{if(!ref.current?.contains(event.target))close()};
    const escape=event=>{if(event.key==='Escape')close()};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);window.addEventListener('blur',close);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('blur',close)};
  },[open]);
  return <details ref={ref} name="rw-actions" className="rw-action-menu" onToggle={event=>setOpen(event.currentTarget.open)}><summary aria-label={label} title={label}><Icon name={icon} size={15}/></summary><div className="rw-action-menu-body" role="group" aria-label={label} onClick={event=>{if(event.target.closest('button'))ref.current.open=false}}>{children}</div></details>;
}
