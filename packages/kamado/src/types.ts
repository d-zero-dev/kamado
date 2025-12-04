/**
 * Page data interface
 */
export interface Page {
	/**
	 * Page ID
	 */
	id: number;
	/**
	 * Page number
	 */
	no: number;
	/**
	 * Deletion flag
	 */
	deleted: string;
	/**
	 * Original URL
	 */
	originalUrl: string;
	/**
	 * Move destination URL
	 */
	moveToUrl: string;
	/**
	 * Whether it is a conversion target
	 */
	isConvertTarget: number;
	/**
	 * Whether it has been converted
	 */
	isConverted: number;
	/**
	 * Title
	 */
	title: string;
	/**
	 * Subtitle
	 */
	subTitle: string;
	/**
	 * Description
	 */
	description: string;
	/**
	 * OGP image URL
	 */
	ogpImg: string;
	/**
	 * Whether to enable local navigation
	 */
	enableLocalNav: number;
	/**
	 * Local navigation position
	 */
	localNavPosition: string;
	/**
	 * Local navigation depth
	 */
	localNavDepth: number;
	/**
	 * Layout name
	 */
	layout: string;
	/**
	 * Whether to enable hero section
	 */
	enableHero: boolean;
	/**
	 * Whether to enable description block
	 */
	enableDescriptionBlock: boolean;
	/**
	 * Whether to enable list of links in page
	 */
	enableListOfLinkInPage: boolean;
	/**
	 * Destination URL
	 */
	to: string;
	/**
	 * Source URL
	 */
	from: string;
	/**
	 * List of scripts
	 */
	scripts: string[];
}
