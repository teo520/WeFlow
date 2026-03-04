import React, { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import './JumpToDatePopover.scss'

interface JumpToDatePopoverProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (date: Date) => void
  className?: string
  style?: React.CSSProperties
  currentDate?: Date
  messageDates?: Set<string>
  hasLoadedMessageDates?: boolean
  messageDateCounts?: Record<string, number>
  loadingDates?: boolean
  loadingDateCounts?: boolean
}

const JumpToDatePopover: React.FC<JumpToDatePopoverProps> = ({
  isOpen,
  onClose,
  onSelect,
  className,
  style,
  currentDate = new Date(),
  messageDates,
  hasLoadedMessageDates = false,
  messageDateCounts,
  loadingDates = false,
  loadingDateCounts = false
}) => {
  const [calendarDate, setCalendarDate] = useState<Date>(new Date(currentDate))
  const [selectedDate, setSelectedDate] = useState<Date>(new Date(currentDate))

  useEffect(() => {
    if (!isOpen) return
    const normalized = new Date(currentDate)
    setCalendarDate(normalized)
    setSelectedDate(normalized)
  }, [isOpen, currentDate])

  if (!isOpen) return null

  const getDaysInMonth = (date: Date): number => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (date: Date): number => {
    const year = date.getFullYear()
    const month = date.getMonth()
    return new Date(year, month, 1).getDay()
  }

  const toDateKey = (day: number): string => {
    const year = calendarDate.getFullYear()
    const month = calendarDate.getMonth() + 1
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const hasMessage = (day: number): boolean => {
    if (!hasLoadedMessageDates) return true
    if (!messageDates || messageDates.size === 0) return false
    return messageDates.has(toDateKey(day))
  }

  const isToday = (day: number): boolean => {
    const today = new Date()
    return day === today.getDate()
      && calendarDate.getMonth() === today.getMonth()
      && calendarDate.getFullYear() === today.getFullYear()
  }

  const isSelected = (day: number): boolean => {
    return day === selectedDate.getDate()
      && calendarDate.getMonth() === selectedDate.getMonth()
      && calendarDate.getFullYear() === selectedDate.getFullYear()
  }

  const generateCalendar = (): Array<number | null> => {
    const daysInMonth = getDaysInMonth(calendarDate)
    const firstDay = getFirstDayOfMonth(calendarDate)
    const days: Array<number | null> = []

    for (let i = 0; i < firstDay; i++) {
      days.push(null)
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i)
    }
    return days
  }

  const handleDateClick = (day: number) => {
    if (hasLoadedMessageDates && !hasMessage(day)) return
    const targetDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), day)
    setSelectedDate(targetDate)
    onSelect(targetDate)
    onClose()
  }

  const getDayClassName = (day: number | null): string => {
    if (day === null) return 'day-cell empty'
    const classes = ['day-cell']
    if (isToday(day)) classes.push('today')
    if (isSelected(day)) classes.push('selected')
    if (hasLoadedMessageDates && !hasMessage(day)) classes.push('no-message')
    return classes.join(' ')
  }

  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  const days = generateCalendar()
  const mergedClassName = ['jump-date-popover', className || ''].join(' ').trim()

  return (
    <div className={mergedClassName} style={style} role="dialog" aria-label="跳转日期">
      <div className="calendar-nav">
        <button
          className="nav-btn"
          onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1))}
          aria-label="上一月"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="current-month">{calendarDate.getFullYear()}年{calendarDate.getMonth() + 1}月</span>
        <button
          className="nav-btn"
          onClick={() => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1))}
          aria-label="下一月"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="status-line">
        {loadingDates && (
          <span className="status-item">
            <Loader2 size={12} className="spin" />
            <span>日期加载中</span>
          </span>
        )}
        {!loadingDates && loadingDateCounts && (
          <span className="status-item">
            <Loader2 size={12} className="spin" />
            <span>条数加载中</span>
          </span>
        )}
      </div>

      <div className="calendar-grid">
        <div className="weekdays">
          {weekdays.map(day => (
            <div key={day} className="weekday">{day}</div>
          ))}
        </div>
        <div className="days">
          {days.map((day, index) => {
            if (day === null) return <div key={index} className="day-cell empty" />
            const dateKey = toDateKey(day)
            const hasMessageOnDay = hasMessage(day)
            const count = Number(messageDateCounts?.[dateKey] || 0)
            const showCount = count > 0
            const showCountLoading = hasMessageOnDay && loadingDateCounts && !showCount
            return (
              <button
                key={index}
                className={getDayClassName(day)}
                onClick={() => handleDateClick(day)}
                disabled={hasLoadedMessageDates && !hasMessageOnDay}
                type="button"
              >
                <span className="day-number">{day}</span>
                {showCount && <span className="day-count">{count}</span>}
                {showCountLoading && <Loader2 size={11} className="day-count-loading spin" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default JumpToDatePopover
