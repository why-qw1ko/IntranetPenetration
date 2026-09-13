import { AlertTriangle } from 'lucide-react'
import './index.css'

export default function ConfirmModal ({ title, message, confirmText = '确定', cancelText = '取消', danger = false, onConfirm, onCancel }) {
  return (
    <div className='modal-overlay' onClick={onCancel}>
      <div className='modal-box confirm-modal' onClick={(e) => e.stopPropagation()}>
        <div className='confirm-icon'><AlertTriangle size={32} strokeWidth={1.5} /></div>
        {title && <div className='modal-title'>{title}</div>}
        {message && <div className='modal-sub'>{message}</div>}
        <div className='confirm-actions'>
          <button className='btn btn-ghost' onClick={onCancel}>{cancelText}</button>
          <button className='btn btn-warning' onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  )
}
