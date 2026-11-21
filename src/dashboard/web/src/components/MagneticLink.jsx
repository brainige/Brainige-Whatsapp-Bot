import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import Icon from './Icons.jsx'

export default function MagneticLink({ href, children }) {
  const ref = useRef(null)

  useEffect(() => {
    const element = ref.current
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let enabled = fine.matches && !reduced.matches

    const xTo = gsap.quickTo(element, 'x', { duration: 0.35, ease: 'power3.out' })
    const yTo = gsap.quickTo(element, 'y', { duration: 0.35, ease: 'power3.out' })
    const move = (event) => {
      if (!enabled) return
      const rect = element.getBoundingClientRect()
      xTo((event.clientX - rect.left - rect.width / 2) * 0.1)
      yTo((event.clientY - rect.top - rect.height / 2) * 0.12)
    }
    const leave = () => { xTo(0); yTo(0) }
    const onChange = () => {
      enabled = fine.matches && !reduced.matches
      if (!enabled) leave()
    }
    element.addEventListener('pointermove', move, { passive: true })
    element.addEventListener('pointerleave', leave)
    fine.addEventListener('change', onChange)
    reduced.addEventListener('change', onChange)
    return () => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerleave', leave)
      fine.removeEventListener('change', onChange)
      reduced.removeEventListener('change', onChange)
      xTo.tween.kill()
      yTo.tween.kill()
      gsap.set(element, { clearProps: 'transform' })
    }
  }, [])

  return <a ref={ref} className="button button--primary" href={href}>{children}<Icon name="arrow" size={17} /></a>
}
