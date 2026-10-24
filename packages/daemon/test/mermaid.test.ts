import { describe, expect, it } from 'vitest';
import { layOutDiagram, MAX_DIAGRAM_LINKS, MAX_MERMAID_LENGTH, parseMermaid, toMermaid, type Diagram } from '../src/mermaid.ts';
import { FILL_SLOT_COLORS, MAX_TEXT_LENGTH, newShapeData, type ShapeData } from '../src/protocol.ts';

/** The shapes of a diagram by id, as `id: kind "text"`. */
const shapesOf = (diagram: Diagram | undefined) => diagram?.shapes.map(({ id, shape, text }) => `${id}: ${shape} ${JSON.stringify(text)}`);
/** The links of a diagram, as `from → to start/end[ dashed] "label"`. */
const linksOf = (diagram: Diagram | undefined) =>
  diagram?.links.map(
    ({ from, to, startEnd, endEnd, dashed, label, startLabel, endLabel }) =>
      `${from} → ${to} ${startEnd}/${endEnd}${dashed ? ' dashed' : ''}${label === '' ? '' : ` ${JSON.stringify(label)}`}${startLabel === '' && endLabel === '' ? '' : ` [${startLabel}|${endLabel}]`}`,
  );

describe('parseMermaid: what is a diagram', () => {
  it('takes only text that opens with a flowchart or class diagram header', () => {
    expect(parseMermaid('just some words')).toBeUndefined();
    expect(parseMermaid('sequenceDiagram\n  A->>B: hi')).toBeUndefined();
    expect(parseMermaid('a graph of sales')).toBeUndefined();
    expect(parseMermaid('flowchart LR\n  A --> B')?.kind).toBe('flowchart');
    expect(parseMermaid('graph TD\n  A --> B')?.kind).toBe('flowchart');
    expect(parseMermaid('classDiagram\n  class A')?.kind).toBe('class');
  });

  it('takes a header only in its own case, and a flowchart only with a bracket or a link in it', () => {
    expect(parseMermaid('Graph\nmilk\neggs')).toBeUndefined();
    expect(parseMermaid('graph\nmilk\neggs')).toBeUndefined();
    expect(parseMermaid('CLASSDIAGRAM\n  class A')).toBeUndefined();
    expect(shapesOf(parseMermaid('graph\n  milk[Milk]'))).toEqual(['milk: rectangle "Milk"']);
  });

  it('draws the first of several fenced diagrams, and says it left the rest out', () => {
    const diagram = parseMermaid(['```mermaid', 'flowchart TD', 'A-->B', '```', 'See also:', '```mermaid', 'flowchart TD', 'C-->D', '```'].join('\n'));
    expect(shapesOf(diagram)).toEqual(['A: rectangle "A"', 'B: rectangle "B"']);
    expect(diagram?.skipped).toEqual(['the text after the first diagram']);
  });

  it('reads a long run of spaces quickly, and passes over a line too long to be one', () => {
    for (const opener of ['--', '-.', '==']) {
      const started = performance.now();
      const diagram = parseMermaid(`flowchart TD\n  A --> B\n  A ${opener}${' '.repeat(4000)}x`);
      expect(performance.now() - started).toBeLessThan(100);
      expect(diagram?.skipped).toHaveLength(1);
    }
    const started = performance.now();
    const long = parseMermaid(`flowchart TD\n  A --> B\n  A --${' '.repeat(79_000)}x`);
    expect(performance.now() - started).toBeLessThan(100);
    expect(long?.skipped).toEqual([expect.stringMatching(/^A -- {20,}… \(a line over 5000 characters\)$/)]);
  });

  it('refuses text past its length', () => {
    expect(() => parseMermaid(`flowchart TD\n  A --> B\n${'%% x\n'.repeat(MAX_MERMAID_LENGTH / 5)}`)).toThrow(/at most 80000 characters/);
    expect(parseMermaid('words '.repeat(MAX_MERMAID_LENGTH))).toBeUndefined();
  });

  it('reads past a code fence, front matter, a directive and comments', () => {
    const text = ['```mermaid', '---', 'title: Orders', '---', '%%{init: {"theme": "dark"}}%%', '%% the flow', 'flowchart LR', '  A --> B', '```'].join('\n');
    expect(linksOf(parseMermaid(text))).toEqual(['A → B none/arrow']);
    expect(parseMermaid(text)?.direction).toBe('LR');
  });
});

describe('parseMermaid: flowcharts', () => {
  it('reads each bracket as its shape, and a bare id as a rectangle named for it', () => {
    const diagram = parseMermaid(
      [
        'flowchart TD',
        '  a[Rect] --> b(Rounded)',
        '  c([Stadium]); d[[Subroutine]]; e[(Database)]',
        '  f((Circle)); g{Decide}; h{{Prepare}}; i[/In out/]; j[\\Lean left\\]',
        '  k[/Trapezoid\\]; l>Flag]',
        '  m',
      ].join('\n'),
    );
    expect(shapesOf(diagram)).toEqual([
      'a: rectangle "Rect"',
      'b: rounded "Rounded"',
      'c: terminator "Stadium"',
      'd: predefined-process "Subroutine"',
      'e: database "Database"',
      'f: ellipse "Circle"',
      'g: diamond "Decide"',
      'h: preparation "Prepare"',
      'i: input-output "In out"',
      'j: input-output "Lean left"',
      'k: manual-input "Trapezoid"',
      'l: rectangle "Flag"',
      'm: rectangle "m"',
    ]);
  });

  it('reads the shape syntax, quoted text, line breaks and entities', () => {
    const diagram = parseMermaid(
      ['flowchart TD', '  a@{ shape: doc, label: "Report" }', '  b@{ shape: cloud }', '  c["Say #quot;hi#quot; (now)"]', '  d["two<br>lines"]', '  e[`**bold**`]'].join('\n'),
    );
    expect(shapesOf(diagram)).toEqual(['a: document "Report"', 'b: cloud "b"', 'c: rectangle "Say \\"hi\\" (now)"', 'd: rectangle "two\\nlines"', 'e: rectangle "**bold**"']);
  });

  it('leaves an entity alone that is no character, and drops control characters, raw or as entities', () => {
    const diagram = parseMermaid(['flowchart TD', '  a["#99999999; #55296; ok"]', '  b["#27;[2Jx\u0007"] -->|"#0;go"| c'].join('\n'));
    expect(shapesOf(diagram)).toEqual(['a: rectangle "#99999999; #55296; ok"', 'b: rectangle "[2Jx"', 'c: rectangle "c"']);
    expect(diagram?.links[0]?.label).toBe('go');
  });

  it('draws one link for each pair joined the same way, and at most the diagram’s limit of links, saying how many more', () => {
    expect(linksOf(parseMermaid('flowchart TD\n  A --> B\n  A --> B\n  B <-- A\n  A -.-> B'))).toEqual(['A → B none/arrow', 'A → B none/arrow dashed']);
    const ids = (letter: string) => Array.from({ length: 30 }, (_, n) => `${letter}${n}`).join(' & ');
    const diagram = parseMermaid(`flowchart TD\n  ${ids('a')} --> ${ids('b')}`);
    expect(diagram?.links).toHaveLength(MAX_DIAGRAM_LINKS);
    expect(diagram?.skipped).toEqual([`${900 - MAX_DIAGRAM_LINKS} more links: a diagram draws at most ${MAX_DIAGRAM_LINKS}`]);
    // The same links again add none to the count.
    const many = (letter: string) => Array.from({ length: 50 }, (_, n) => `${letter}${n}`).join(' & ');
    const twice = parseMermaid(`flowchart TD\n  ${many('a')} --> ${many('b')}\n  ${many('a')} --> ${many('b')}\n  b0 <-- a0`);
    expect(twice?.skipped).toEqual([`${2500 - MAX_DIAGRAM_LINKS} more links: a diagram draws at most ${MAX_DIAGRAM_LINKS}`]);
  });

  it('reads a line joining every one of 400 nodes to another 400 quickly', () => {
    const many = (letter: string) => Array.from({ length: 400 }, (_, n) => `${letter}${n}`).join('&');
    const started = performance.now();
    const diagram = parseMermaid(`flowchart TD\n  ${many('a')}-->${many('b')}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(diagram?.shapes).toHaveLength(200);
  });

  it('counts no link to a shape past the shapes’ limit as a link left out: the shape count says so', () => {
    const diagram = parseMermaid(['flowchart TD', ...Array.from({ length: 205 }, (_, n) => `  hub --> n${n}`)].join('\n'));
    expect(diagram?.links).toHaveLength(199);
    expect(diagram?.skipped).toEqual(['6 more shapes: a diagram draws at most 200']);
  });

  it('keeps the first shape a node is given, wherever it is first named', () => {
    const diagram = parseMermaid(['flowchart TD', '  A --> B', '  B{Ok?} --> A[Start]'].join('\n'));
    expect(shapesOf(diagram)).toEqual(['A: rectangle "Start"', 'B: diamond "Ok?"']);
  });

  it('reads each kind of link, its ends and dash', () => {
    const diagram = parseMermaid(
      ['flowchart LR', '  A --> B', '  A --- C', '  A -.-> D', '  A -.- E', '  A ==> F', '  A <--> G', '  A --o H', '  A --x I', '  J <-- A'].join('\n'),
    );
    expect(linksOf(diagram)).toEqual([
      'A → B none/arrow',
      'A → C none/none',
      'A → D none/arrow dashed',
      'A → E none/none dashed',
      'A → F none/arrow',
      'A → G arrow/arrow',
      'A → H none/dot',
      'A → I none/arrow',
      'A → J none/arrow',
    ]);
  });

  it('reads a circle or cross end written against the next node', () => {
    expect(linksOf(parseMermaid('flowchart LR\n  C--oD\n  E--xF\n  G---oH\n  I==oJ'))).toEqual(['C → D none/dot', 'E → F none/arrow', 'G → H none/dot', 'I → J none/dot']);
  });

  it('reads a link’s label, between pipes or in the line', () => {
    const diagram = parseMermaid(['flowchart TD', '  A -->|yes| B', '  A -- no --> C', '  A -. maybe .-> D', '  A == sure ==> E', '  A ---|plain| F'].join('\n'));
    expect(linksOf(diagram)).toEqual(['A → B none/arrow "yes"', 'A → C none/arrow "no"', 'A → D none/arrow dashed "maybe"', 'A → E none/arrow "sure"', 'A → F none/none "plain"']);
  });

  it('reads a chain of links, and & joining several nodes', () => {
    const diagram = parseMermaid(['flowchart TD', '  A --> B --> C', '  A & B --> D & E'].join('\n'));
    expect(linksOf(diagram)).toEqual(['A → B none/arrow', 'B → C none/arrow', 'A → D none/arrow', 'A → E none/arrow', 'B → D none/arrow', 'B → E none/arrow']);
  });

  it('flattens subgraphs, and passes over the lines it does not draw, saying which', () => {
    const diagram = parseMermaid(
      ['flowchart TD', '  subgraph one [The first]', '    direction LR', '    A --> B', '  end', '  classDef hot fill:#f00', '  class A hot', '  click A "https://example.com"', '  linkStyle 0 stroke:#f00', '  A --> B:::hot', '  ??? what'].join('\n'),
    );
    expect(shapesOf(diagram)).toEqual(['A: rectangle "A"', 'B: rectangle "B"']);
    expect(linksOf(diagram)).toEqual(['A → B none/arrow']);
    expect(diagram?.skipped).toEqual(['classDef hot fill:#f00', 'class A hot', 'click A "https://example.com"', 'linkStyle 0 stroke:#f00', '??? what']);
  });

  it('draws at most the diagram’s limit of shapes, and says how many more it left out', () => {
    const diagram = parseMermaid(['flowchart TD', ...Array.from({ length: 202 }, (_, n) => `  n${n} --> n${n + 1}`)].join('\n'));
    expect(diagram?.shapes).toHaveLength(200);
    expect(diagram?.links).toHaveLength(199);
    expect(diagram?.skipped).toEqual(['3 more shapes: a diagram draws at most 200']);
  });

  it('takes a style’s fill, in the theme slot it is when it is one', () => {
    const diagram = parseMermaid(['flowchart TD', '  A; B; C; D', `  style A fill:${FILL_SLOT_COLORS.green},stroke:#333`, '  style B fill:#123456', '  style C fill:none'].join('\n'));
    expect(diagram?.shapes.map(({ fill }) => fill)).toEqual([
      { fill: FILL_SLOT_COLORS.green, fillSlot: 'green' },
      { fill: '#123456', fillSlot: null },
      { fill: null, fillSlot: null },
      undefined,
    ]);
  });
});

describe('parseMermaid: class diagrams', () => {
  it('reads a class’s members from its block and from member lines, methods by their brackets', () => {
    const diagram = parseMermaid(
      ['classDiagram', '  class Order {', '    +UUID id', '    +total() Money', '  }', '  Order : +List~Line~ lines', '  Order : +cancel()', '  class Line'].join('\n'),
    );
    expect(diagram?.shapes).toMatchObject([
      { id: 'Order', shape: 'class', text: 'Order', attributes: '+UUID id\n+List<Line> lines', methods: '+total() Money\n+cancel()' },
      { id: 'Line', shape: 'class', text: 'Line', attributes: '', methods: '' },
    ]);
  });

  it('draws an interface as a box interface, and another annotation as a stereotype over the name', () => {
    const diagram = parseMermaid(['classDiagram', '  class Shape {', '    <<interface>>', '    +area() float', '  }', '  <<abstract>> Animal', '  class Repo~T~', '  class Odd["An odd name"]'].join('\n'));
    expect(shapesOf(diagram)).toEqual(['Shape: interface-box "Shape"', 'Animal: class "«abstract»\\nAnimal"', 'Repo: class "Repo<T>"', 'Odd: class "An odd name"']);
  });

  it('decodes a stereotype as it does a name, control characters dropped', () => {
    expect(shapesOf(parseMermaid('classDiagram\n  <<#27;[2Jodd#quot;>> A\n  class B {\n    <<x\u0007y>>\n  }'))).toEqual(['A: class "«[2Jodd\\"»\\nA"', 'B: class "«xy»\\nB"']);
  });

  it('reads each relation the way the board draws it, from → to as it reads', () => {
    const diagram = parseMermaid(
      [
        'classDiagram',
        '  Animal <|-- Duck',
        '  Fish --|> Animal',
        '  Shape <|.. Square',
        '  Circle ..|> Shape',
        '  Car *-- Wheel',
        '  Engine --* Car',
        '  Pond o-- Duck',
        '  Duck --> Pond',
        '  Duck ..> Food',
        '  Duck -- Fish',
        '  Duck .. Fish',
        '  Fish <-- Duck',
      ].join('\n'),
    );
    expect(linksOf(diagram)).toEqual([
      'Duck → Animal none/triangle',
      'Fish → Animal none/triangle',
      'Square → Shape none/triangle dashed',
      'Circle → Shape none/triangle dashed',
      'Car → Wheel filled-diamond/none',
      'Car → Engine filled-diamond/none',
      'Pond → Duck diamond/none',
      'Duck → Pond none/arrow',
      'Duck → Food none/arrow dashed',
      'Duck → Fish none/none',
      'Duck → Fish none/none dashed',
      'Duck → Fish none/arrow',
    ]);
  });

  it('keeps each end’s multiplicity by its end, and the label on the middle, when it turns a relation round', () => {
    const diagram = parseMermaid(['classDiagram', '  Customer "1" --> "0..*" Order : places', '  Animal "1" <|-- "many" Duck : is a'].join('\n'));
    expect(linksOf(diagram)).toEqual(['Customer → Order none/arrow "places" [1|0..*]', 'Duck → Animal none/triangle "is a" [many|1]']);
  });

  it('cuts a class to the length a shape holds, its name and sections together', () => {
    const lines = (prefix: string) => Array.from({ length: 1200 }, (_, n) => `    ${prefix}${String(n).padStart(6, '0')}`);
    const diagram = parseMermaid(['classDiagram', '  class Big {', ...lines('+a'), ...lines('+m()'), '  }'].join('\n'))!;
    const [big] = diagram.shapes;
    expect(big!.text.length + big!.attributes.length + big!.methods.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(big!.methods.length).toBeGreaterThan(0);
  });

  it('takes a style’s fill, and passes over notes', () => {
    const diagram = parseMermaid(['classDiagram', '  class A', '  note for A "a note"', `  style A fill:${FILL_SLOT_COLORS.blue}`].join('\n'));
    expect(diagram?.shapes[0]?.fill).toEqual({ fill: FILL_SLOT_COLORS.blue, fillSlot: 'blue' });
    expect(diagram?.skipped).toEqual(['note for A "a note"']);
  });
});

/** A board shape's data, the board's new one of `shape` with `data` over it. */
const shapeData = (shape: ShapeData['shape'], data: Partial<ShapeData> = {}): ShapeData => ({ ...newShapeData(shape), ...data });

describe('toMermaid', () => {
  it('writes a flowchart for shapes without a class among them, a link to each connector', () => {
    const text = toMermaid(
      [
        { id: 'x1', data: shapeData('terminator', { text: 'Start' }) },
        { id: 'x2', data: shapeData('diamond', { text: 'Say "ok"?\nor not' }) },
        { id: 'x3', data: shapeData('document', { text: 'Report', fill: FILL_SLOT_COLORS.green, fillSlot: 'green' }) },
        { id: 'x4', data: shapeData('server', { text: 'Box' }) },
      ],
      [
        { from: { id: 'x1', side: 'bottom' }, to: { id: 'x2', side: 'top' }, startEnd: 'none', endEnd: 'arrow', dashed: false, label: '', startLabel: '', endLabel: '' },
        { from: { id: 'x2', side: 'bottom' }, to: { id: 'x3', side: 'top' }, startEnd: 'none', endEnd: 'arrow', dashed: true, label: 'yes|no', startLabel: '', endLabel: '' },
        { from: { id: 'x3', side: 'bottom' }, to: { id: 'x4', side: 'top' }, startEnd: 'arrow', endEnd: 'arrow', dashed: false, label: '', startLabel: '', endLabel: '' },
        { from: { id: 'x4', side: 'bottom' }, to: { id: 'gone', side: 'top' }, startEnd: 'none', endEnd: 'arrow', dashed: false, label: '', startLabel: '', endLabel: '' },
      ],
    );
    expect(text).toBe(
      [
        'flowchart TD',
        '  n1(["Start"])',
        '  n2{"Say #quot;ok#quot;?<br>or not"}',
        '  n3@{ shape: doc, label: "Report" }',
        '  n4["Box"]',
        '  n1 --> n2',
        '  n2 -.->|"yes#124;no"| n3',
        '  n3 <--> n4',
        `  style n3 fill:${FILL_SLOT_COLORS.green}`,
        '',
      ].join('\n'),
    );
  });

  it('writes a flowchart left to right when most of its connectors run sideways', () => {
    const text = toMermaid(
      [
        { id: 'x1', data: shapeData('rectangle', { text: 'A' }) },
        { id: 'x2', data: shapeData('rectangle', { text: 'B' }) },
      ],
      [{ from: { id: 'x1', side: 'right' }, to: { id: 'x2', side: 'left' }, startEnd: 'none', endEnd: 'none', dashed: false, label: '', startLabel: '', endLabel: '' }],
    );
    expect(text).toBe(['flowchart LR', '  n1["A"]', '  n2["B"]', '  n1 --- n2', ''].join('\n'));
  });

  it('writes a class diagram when a class is among the shapes, each relation as Mermaid writes it', () => {
    const text = toMermaid(
      [
        { id: 'o', data: shapeData('class', { text: 'Order', attributes: '+UUID id\n+List<Line> lines', methods: '+total() Money' }) },
        { id: 'l', data: shapeData('class', { text: 'Line Item' }) },
        { id: 'p', data: shapeData('interface-box', { text: 'Priced', fill: '#123456', fillSlot: null }) },
        { id: 'e', data: shapeData('class', { text: '«entity»\nCustomer' }) },
      ],
      [
        { from: { id: 'o', side: 'bottom' }, to: { id: 'l', side: 'top' }, startEnd: 'filled-diamond', endEnd: 'none', dashed: false, label: 'holds', startLabel: '1', endLabel: '0..*' },
        { from: { id: 'o', side: 'top' }, to: { id: 'p', side: 'bottom' }, startEnd: 'none', endEnd: 'triangle', dashed: true, label: '', startLabel: '', endLabel: '' },
        { from: { id: 'e', side: 'bottom' }, to: { id: 'o', side: 'top' }, startEnd: 'none', endEnd: 'arrow', dashed: false, label: '', startLabel: '', endLabel: '' },
      ],
    );
    expect(text).toBe(
      [
        'classDiagram',
        '  class Order {',
        '    +UUID id',
        '    +List~Line~ lines',
        '    +total() Money',
        '  }',
        '  class Line_Item["Line Item"]',
        '  class Priced {',
        '    <<interface>>',
        '  }',
        '  class Customer {',
        '    <<entity>>',
        '  }',
        '  Order "1" *-- "0..*" Line_Item : holds',
        '  Order ..|> Priced',
        '  Customer --> Order',
        '  style Priced fill:#123456',
        '',
      ].join('\n'),
    );
  });
});

describe('toMermaid: members Mermaid would read as something else', () => {
  it('writes a member that is a closing brace, an annotation or an entity so it reads back as itself', () => {
    const shapes = [{ id: 'x', data: shapeData('class', { text: 'Odd', attributes: '}\n<<odd>>\nissue #35;', methods: 'run()' }) }];
    const back = parseMermaid(toMermaid(shapes, []));
    expect(back?.shapes[0]).toMatchObject({ text: 'Odd', attributes: '}\n<<odd>>\nissue #35;', methods: 'run()' });
    expect(back?.skipped).toEqual([]);
  });
});

describe('a round trip', () => {
  /** Board shapes and connectors as a diagram reads, ids and all, so the diagram read back can be put beside it. */
  const asBoard = (diagram: Diagram) => ({
    shapes: diagram.shapes.map(({ id, shape, text, attributes, methods, fill }) => ({ id, data: shapeData(shape, { text, attributes, methods, ...fill }) })),
    connectors: diagram.links.map(({ from, to, ...look }) => ({ from: { id: from, side: 'bottom' as const }, to: { id: to, side: 'top' as const }, ...look })),
  });
  /** What a diagram draws, without the ids the export picks. */
  const drawn = (diagram: Diagram | undefined) => {
    const index = new Map(diagram?.shapes.map(({ id }, n) => [id, n]));
    return {
      kind: diagram?.kind,
      shapes: diagram?.shapes.map(({ shape, text, attributes, methods, fill }) => ({ shape, text, attributes, methods, fill })),
      links: diagram?.links.map(({ from, to, ...look }) => ({ from: index.get(from), to: index.get(to), ...look })),
    };
  };
  const again = (text: string) => {
    const first = parseMermaid(text)!;
    const { shapes, connectors } = asBoard(first);
    const exported = toMermaid(shapes, connectors);
    return { first, exported, second: parseMermaid(exported) };
  };

  it('brings a flowchart back as it was, every shape and link', () => {
    const { first, exported, second } = again(
      [
        'flowchart TD',
        '  a([Start]) --> b{"Is it #quot;ok#quot;?"}',
        '  b -->|yes| c[[Run]] -.-> d[(Store)]',
        '  b -- no --> e((Stop)) --- f{{Prep}}',
        '  f <--> g[/Input/] --o h@{ shape: docs, label: "Pages" }',
        '  h ==> i(Rounded) --> j["two<br>lines"]',
        '  k@{ shape: delay } --> l@{ shape: cloud, label: "Sky" }',
        `  style c fill:${FILL_SLOT_COLORS.violet}`,
        '  style d fill:#abcdef',
      ].join('\n'),
    );
    expect(drawn(second)).toEqual(drawn(first));
    expect(toMermaid(asBoard(second!).shapes, asBoard(second!).connectors)).toBe(exported);
  });

  it('brings a class diagram back as it was, every relation, label and member', () => {
    const { first, exported, second } = again(
      [
        'classDiagram',
        '  class Order {',
        '    +UUID id',
        '    +List~Line~ lines',
        '    +total() Money',
        '  }',
        '  class Priced {',
        '    <<interface>>',
        '    +price() Money',
        '  }',
        '  <<entity>> Customer',
        '  class Odd["An odd name"]',
        '  Customer "1" --> "0..*" Order : places',
        '  Order ..|> Priced',
        '  Base <|-- Order',
        '  Order "1" *-- "many" Line : holds',
        '  Cart o-- Line',
        '  Order ..> Odd',
        '  Order -- Cart',
        '  Order .. Base',
        `  style Cart fill:${FILL_SLOT_COLORS.pink}`,
      ].join('\n'),
    );
    expect(drawn(second)).toEqual(drawn(first));
    expect(toMermaid(asBoard(second!).shapes, asBoard(second!).connectors)).toBe(exported);
  });
});

describe('layOutDiagram', () => {
  it('puts each rank of a top-down flowchart in a row below the last, clear of each other, from 0,0', () => {
    const { shapes, width, height } = layOutDiagram(parseMermaid('flowchart TD\n  A --> B\n  A --> C\n  B --> D\n  C --> D')!);
    const at = Object.fromEntries(shapes.map(({ key, x, y, width, height }) => [key, { x, y, width, height }]));
    expect(at.A!.y).toBe(0);
    expect(at.B!.y).toBe(at.C!.y);
    expect(at.B!.y).toBeGreaterThan(at.A!.y + at.A!.height);
    expect(at.D!.y).toBeGreaterThan(at.B!.y + at.B!.height);
    expect(at.C!.x).toBeGreaterThan(at.B!.x + at.B!.width);
    expect(Math.min(...shapes.map(({ x }) => x))).toBe(0);
    expect(width).toBe(Math.max(...shapes.map(({ x, width }) => x + width)));
    expect(height).toBe(Math.max(...shapes.map(({ y, height }) => y + height)));
  });

  it('runs a left-to-right flowchart in columns, and joins each pair on the sides that face', () => {
    const { shapes, links } = layOutDiagram(parseMermaid('flowchart LR\n  A --> B')!);
    const [a, b] = shapes;
    expect(b!.x).toBeGreaterThan(a!.x + a!.width);
    expect(b!.y).toBe(a!.y);
    expect(links).toEqual([{ from: { key: 'A', side: 'right' }, to: { key: 'B', side: 'left' }, look: { startEnd: 'none', endEnd: 'arrow', dashed: false, label: '', startLabel: '', endLabel: '' } }]);
  });

  it('puts a parent class above its children, and a whole above its parts', () => {
    const { shapes, links } = layOutDiagram(parseMermaid('classDiagram\n  Animal <|-- Duck\n  Duck *-- Wing')!);
    const y = Object.fromEntries(shapes.map(({ key, y }) => [key, y]));
    expect(y.Animal).toBeLessThan(y.Duck!);
    expect(y.Duck).toBeLessThan(y.Wing!);
    expect(links.map(({ from, to }) => `${from.key}.${from.side} → ${to.key}.${to.side}`)).toEqual(['Duck.top → Animal.bottom', 'Duck.bottom → Wing.top']);
  });

  it('lays out a cycle without looping', () => {
    const { shapes } = layOutDiagram(parseMermaid('flowchart TD\n  A --> B --> C --> A')!);
    expect(new Set(shapes.map(({ y }) => y)).size).toBe(3);
  });

  it('gives each shape the board’s new data with its text, sections and fill, sized for them', () => {
    const { shapes } = layOutDiagram(parseMermaid(`classDiagram\n  class Order {\n    +UUID id\n    +total() Money\n  }\n  style Order fill:${FILL_SLOT_COLORS.green}`)!);
    expect(shapes[0]!.data).toEqual({ ...newShapeData('class'), text: 'Order', attributes: '+UUID id', methods: '+total() Money', fill: FILL_SLOT_COLORS.green, fillSlot: 'green' });
    expect(shapes[0]!.height).toBeGreaterThan(80);
  });
});
