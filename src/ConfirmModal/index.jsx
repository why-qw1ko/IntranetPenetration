import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import './index.css'

export default function ConfirmModal ({ title, message, confirmText = '确定', cancelText = '取消', danger = false, onConfirm, onCancel }) {
  const titleId = useId()
  const messageId = useId()
  const dialog = useRef(null)
  const active = useRef(false)
  const busy = useRef(false)
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  const [pending, setPending] = useState(false)

  useEffect(() => {
    active.current = true
    const previous = document.activeElement
    dialog.current?.querySelector('button')?.focus()
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!busy.current) cancel.current()
      } else if (event.key === 'Tab') {
        const buttons = [...dialog.current.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
        const first = buttons[0]
        const last = buttons.at(-1)
        if (!first) { event.preventDefault(); dialog.current.focus(); return }
        if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      active.current = false
      document.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  const confirm = async () => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try { await onConfirm() } finally {
      busy.current = false
      if (active.current) setPending(false)
    }
  }

  return (
    <div className='modal-overlay' onClick={() => { if (!busy.current) onCancel() }}>
      <div ref={dialog} role='dialog' aria-modal='true' aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : '确认操作'} aria-describedby={message ? messageId : undefined} tabIndex={-1} className='modal-box confirm-modal' onClick={(e) => e.stopPropagation()}>
        <div className='confirm-icon'><AlertTriangle size={32} strokeWidth={1.5} /></div>
        {title && <div className='modal-title' id={titleId}>{title}</div>}
        {message && <div className='modal-sub' id={messageId}>{message}</div>}
        <div className='confirm-actions'>
          <button className='btn btn-ghost' onClick={onCancel} disabled={pending}>{cancelText}</button>
          <button className={danger ? 'btn btn-danger' : 'btn btn-brand'} onClick={confirm} disabled={pending}>{pending ? '处理中…' : confirmText}</button>
        </div>
      </div>
    </div>
  )
}
