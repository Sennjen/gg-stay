/**
 * A deliberately strict XML reader for the sitemap tests: just enough of XML 1.0 for what a sitemap
 * is made of (a prolog, elements, double-quoted attributes, text with the five predefined
 * entities), and it throws on anything else — an unclosed or mismatched tag, a bare `&`, a `<` in
 * text, an undeclared namespace prefix. Asserting on a tree it built proves the document parses,
 * which a regex over the string never would.
 */

export interface XmlElement {
  name: string
  attributes: Record<string, string>
  children: XmlElement[]
  text: string
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/
const ENTITY = /&(?:amp|lt|gt|quot|apos);/g
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

function decode(raw: string, where: string): string {
  if (raw.replace(ENTITY, '').includes('&')) throw new Error(`Bare "&" in ${where}`)
  if (raw.includes('<')) throw new Error(`Bare "<" in ${where}`)
  return raw.replace(ENTITY, (entity) => ENTITIES[entity]!)
}

export function parseXml(xml: string): XmlElement {
  let position = 0
  const prolog = /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/.exec(xml)
  if (!prolog) throw new Error('Missing or wrong XML declaration')
  position = prolog[0].length

  function element(namespaces: Set<string>): XmlElement {
    if (xml[position] !== '<') throw new Error(`Expected an element at ${position}`)
    position += 1
    const name = NAME.exec(xml.slice(position))?.[0]
    if (!name) throw new Error(`Bad element name at ${position}`)
    position += name.length
    const attributes: Record<string, string> = {}
    for (;;) {
      const space = /^\s*/.exec(xml.slice(position))![0]
      position += space.length
      if (xml.startsWith('/>', position) || xml[position] === '>') break
      if (!space) throw new Error(`Expected whitespace before an attribute at ${position}`)
      const attribute = /^([A-Za-z_][\w.:-]*)="([^"]*)"/.exec(xml.slice(position))
      if (!attribute) throw new Error(`Bad attribute at ${position}`)
      if (attribute[1]! in attributes) throw new Error(`Duplicate attribute ${attribute[1]}`)
      attributes[attribute[1]!] = decode(attribute[2]!, `attribute ${attribute[1]}`)
      position += attribute[0].length
    }
    const declared = new Set(namespaces)
    for (const key of Object.keys(attributes)) {
      if (key.startsWith('xmlns:')) declared.add(key.slice('xmlns:'.length))
    }
    for (const qualified of [name, ...Object.keys(attributes)]) {
      const prefix = qualified.includes(':') ? qualified.split(':')[0]! : null
      if (prefix && prefix !== 'xmlns' && !declared.has(prefix)) {
        throw new Error(`Undeclared namespace prefix "${prefix}" on ${qualified}`)
      }
    }
    const node: XmlElement = { name, attributes, children: [], text: '' }
    if (xml.startsWith('/>', position)) {
      position += 2
      return node
    }
    position += 1
    for (;;) {
      const textEnd = xml.indexOf('<', position)
      if (textEnd === -1) throw new Error(`Unclosed <${name}>`)
      node.text += decode(xml.slice(position, textEnd), `<${name}>`)
      position = textEnd
      if (xml.startsWith(`</${name}>`, position)) {
        position += name.length + 3
        node.text = node.text.trim()
        return node
      }
      if (xml.startsWith('</', position)) throw new Error(`Mismatched closing tag in <${name}>`)
      node.children.push(element(declared))
    }
  }

  const root = element(new Set())
  if (xml.slice(position).trim() !== '') throw new Error('Content after the root element')
  return root
}

/** The direct children of `node` named `name`. */
export function childrenNamed(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((child) => child.name === name)
}

/** The text of the one direct child named `name`, or `undefined`. */
export function childText(node: XmlElement, name: string): string | undefined {
  return childrenNamed(node, name)[0]?.text
}
